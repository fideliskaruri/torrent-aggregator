import { useRef } from "react";

/**
 * Where keyboard focus goes when a dialog closes, or when the control that
 * had it goes away.
 *
 * Radix hands focus back only to its own `Dialog.Trigger`, and no dialog here
 * has one: each opens from state, often from a row menu. So every close
 * dropped focus on <body> and a keyboard or screen-reader user was thrown back
 * to the top of the page. `DialogContent` and `AlertDialogContent` use this to
 * send focus back to what opened them:
 *  - A dialog opened from a menu item returns to the button that opened the
 *    menu. The menu, and the item, are gone by the time the dialog closes.
 *  - When that control is gone too (Delete removed its row), focus moves to
 *    the same control in the row that took its place, else the one before it,
 *    else the nearest thing still on screen.
 *  - Focus is followed for a few seconds after the close, because most actions
 *    remove their row only when the refreshed list arrives, after the dialog
 *    has already closed.
 *  - Focus never goes back into a dialog that has closed. A dialog that opens
 *    in place of one that is closing (the folder browser that stands in for
 *    the download setup form), or whose opener's dialog shut while it was up
 *    (details that went away under their own delete confirmation), returns to
 *    where that dialog was opened from.
 */

/** What can take focus with the Tab key, before visibility checks. */
const INTERACTIVE =
  'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Long enough for the refreshed list to arrive after the dialog closes. */
const FOLLOW_MS = 10_000;

const DIALOG = '[role="dialog"], [role="alertdialog"]';

/** State Radix and the app toggle on the same control; not part of what the control is. */
const TRANSIENT_DATA = new Set([
  "data-state",
  "data-highlighted",
  "data-disabled",
  "data-orientation",
  "data-side",
  "data-align",
  "data-placeholder",
]);

interface Step {
  node: Element;
  parent: Element;
  index: number;
  next: Element | null;
  prev: Element | null;
}

interface FocusAnchor {
  element: HTMLElement;
  /** Tag, role and data hooks: finds "the same control" in the neighbouring row. */
  signature: string;
  /** Where the element sat, innermost first, so a neighbour can be found once it is gone. */
  path: Step[];
  pathname: string;
}

type AutoFocusHandler = ((event: Event) => void) | undefined;

let lastTouched: HTMLElement | null = null;
let stopFollowing: (() => void) | null = null;
/** What each dialog was opened from, by its content element. */
const openers = new WeakMap<Element, FocusAnchor | null>();

if (typeof document !== "undefined") {
  // Radix moves focus into a dialog only after it opens. When the opener was
  // a menu item, the menu has unmounted by then and focus already sits on
  // <body>, so the last control touched is the only record of where the user was.
  const remember = (event: Event) => {
    lastTouched = controlFor(event.target);
  };
  document.addEventListener("focusin", remember, true);
  document.addEventListener("pointerdown", remember, true);
}

/**
 * Focus handlers for a Radix dialog's content. Remembers what had focus when
 * it opened and puts focus back there, or next to it, when it closes. A
 * caller's own `onCloseAutoFocus` runs first; if it places focus itself
 * (`preventDefault`), that control is followed instead.
 */
export function useFocusReturn(onOpenAutoFocus: AutoFocusHandler, onCloseAutoFocus: AutoFocusHandler) {
  const openedFrom = useRef<FocusAnchor | null>(null);
  return {
    onOpenAutoFocus(event: Event) {
      openedFrom.current = captureOpener();
      // Radix fires this on the content element.
      if (event.target instanceof Element) openers.set(event.target, openedFrom.current);
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus(event: Event) {
      onCloseAutoFocus?.(event);
      const from = openedFrom.current;
      openedFrom.current = null;
      if (event.defaultPrevented) {
        keepFocusNear(document.activeElement);
        return;
      }
      // Radix would focus its trigger, which these dialogs don't have.
      event.preventDefault();
      returnFocus(from);
    },
  };
}

/**
 * Keeps focus from falling to <body> when `element`, which has focus, is
 * removed in the next few seconds: a "Mark read" button that disappears once
 * the item is read, a row that goes once the refreshed list arrives. Focus
 * moves to the same control nearby instead. Stops as soon as the user clicks
 * or moves focus themselves.
 */
export function keepFocusNear(element: Element | null) {
  stopFollowing?.();
  if (!canHoldFocus(element) || document.activeElement !== element) return;
  let anchor = snapshot(element);

  const observer = new MutationObserver(() => {
    if (anchor.element.isConnected) return;
    const active = document.activeElement;
    if ((active && active !== document.body) || anchor.pathname !== window.location.pathname) {
      stop();
      return;
    }
    const next = findNear(anchor);
    // Nothing yet: the list may still be re-rendering. Keep watching.
    if (!next) return;
    anchor = snapshot(next);
    moveFocus(next, true);
  });
  const onFocusIn = (event: FocusEvent) => {
    if (event.target !== anchor.element) stop();
  };
  const timer = window.setTimeout(stop, FOLLOW_MS);

  function stop() {
    observer.disconnect();
    window.clearTimeout(timer);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("pointerdown", stop, true);
    if (stopFollowing === stop) stopFollowing = null;
  }

  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("pointerdown", stop, true);
  stopFollowing = stop;
}

function captureOpener(): FocusAnchor | null {
  const active = document.activeElement;
  const opener = active && active !== document.body ? controlFor(active) : lastTouched;
  if (!opener) return null;
  // Opened from inside a dialog that is closing or gone: this one replaced it.
  const dialog = opener.closest(DIALOG);
  if (isClosedDialog(dialog)) return openers.get(dialog) ?? null;
  return opener.isConnected ? snapshot(opener) : null;
}

function returnFocus(from: FocusAnchor | null) {
  // The dialog closed because the page changed: the new page owns focus.
  if (!from || from.pathname !== window.location.pathname) return;
  // Something took focus on purpose, like the player that replaced this dialog.
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  const target = returnTarget(from);
  if (!target) return;
  moveFocus(target, target !== from.element);
  keepFocusNear(target);
}

/**
 * The opener, else the same control near it. An opener inside a dialog that
 * has closed since stands for where that dialog was opened from.
 */
function returnTarget(from: FocusAnchor): HTMLElement | null {
  let anchor: FocusAnchor | null = from;
  // Each step moves one dialog further out; the bound only guards the loop.
  for (let depth = 0; anchor && depth < 8; depth++) {
    if (anchor.pathname !== window.location.pathname) return null;
    const dialog: Element | null = anchor.element.closest(DIALOG);
    if (!isClosedDialog(dialog)) return canHoldFocus(anchor.element) ? anchor.element : findNear(anchor);
    anchor = openers.get(dialog) ?? null;
  }
  return null;
}

/** A dialog that opened through `useFocusReturn` and is now closing or gone. */
function isClosedDialog(dialog: Element | null): dialog is Element {
  return !!dialog && openers.has(dialog) && (!dialog.isConnected || dialog.getAttribute("data-state") === "closed");
}

/** The control behind an event target. A menu item stands for the button that opened its menu, which outlives it. */
function controlFor(target: EventTarget | null): HTMLElement | null {
  let element = target instanceof Element ? target : null;
  for (let hops = 0; element && hops < 4; hops++) {
    const labelledBy = element.closest('[role="menu"]')?.getAttribute("aria-labelledby");
    const trigger = labelledBy ? document.getElementById(labelledBy.split(/\s+/)[0]) : null;
    if (!trigger) break;
    element = trigger;
  }
  const control = element?.closest(INTERACTIVE) ?? element;
  return control instanceof HTMLElement ? control : null;
}

function snapshot(element: HTMLElement): FocusAnchor {
  const path: Step[] = [];
  for (let node: Element = element; node.parentElement && node !== document.body; node = node.parentElement) {
    const parent = node.parentElement;
    path.push({
      node,
      parent,
      index: Array.from(parent.children).indexOf(node),
      next: node.nextElementSibling,
      prev: node.previousElementSibling,
    });
  }
  return { element, signature: signatureOf(element), path, pathname: window.location.pathname };
}

function signatureOf(element: Element): string {
  const hooks = Array.from(element.attributes, (attribute) => attribute.name)
    .filter((name) => name.startsWith("data-") && !TRANSIENT_DATA.has(name))
    .sort();
  return [element.tagName, element.getAttribute("role") ?? "", element.getAttribute("aria-haspopup") ?? "", ...hooks].join("|");
}

/**
 * The nearest control to where the anchor sat, one level out at a time: first
 * the same kind of control in what took its place or followed it, then in
 * what preceded it, then anything focusable. Never crosses into another layer
 * under <body> (a toast, an unrelated dialog).
 */
function findNear(anchor: FocusAnchor): HTMLElement | null {
  for (const step of anchor.path) {
    const { parent } = step;
    if (parent === document.body) break;
    if (!parent.isConnected) continue;
    const children = Array.from(parent.children);
    let after: Element[];
    let before: Element[];
    if (step.node.parentElement === parent) {
      const at = children.indexOf(step.node);
      after = children.slice(at + 1);
      before = children.slice(0, at).reverse();
    } else {
      const at =
        step.next?.parentElement === parent
          ? children.indexOf(step.next)
          : step.prev?.parentElement === parent
            ? children.indexOf(step.prev) + 1
            : Math.min(step.index, children.length);
      after = children.slice(at);
      before = children.slice(0, at).reverse();
    }
    for (const signature of [anchor.signature, null]) {
      for (const branch of after) {
        const found = firstFocusable(branch, signature, false);
        if (found) return found;
      }
      for (const branch of before) {
        const found = firstFocusable(branch, signature, true);
        if (found) return found;
      }
    }
  }
  return null;
}

function firstFocusable(root: Element, signature: string | null, fromEnd: boolean): HTMLElement | null {
  const candidates = [root, ...root.querySelectorAll(INTERACTIVE)];
  if (fromEnd) candidates.reverse();
  for (const candidate of candidates) {
    if (canHoldFocus(candidate) && candidate.tabIndex >= 0 && (signature == null || signatureOf(candidate) === signature)) {
      return candidate;
    }
  }
  return null;
}

function canHoldFocus(element: Element | null): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.isConnected &&
    element !== document.body &&
    (element.tabIndex >= 0 || element.hasAttribute("tabindex")) &&
    !element.matches(":disabled") &&
    !element.closest('[inert], [aria-hidden="true"]') &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden"
  );
}

function moveFocus(element: HTMLElement, reveal: boolean) {
  element.focus({ preventScroll: true });
  if (reveal) element.scrollIntoView({ block: "nearest", inline: "nearest" });
}
