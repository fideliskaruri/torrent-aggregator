#!/usr/bin/env node
/**
 * Arm, disarm, and spend the autopilot budget.
 *
 * Separate from the plugin so the switch is reachable without a running
 * session — an automation you can only stop from inside the thing being
 * automated is not one you control.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "docs", ".autopilot.json");

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { armed: false, budget: 0 };
  }
}
function write(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case "on": {
    const budget = Number(arg ?? 25);
    if (!Number.isInteger(budget) || budget < 1 || budget > 500) {
      console.error("budget must be an integer between 1 and 500");
      process.exit(1);
    }
    write({ armed: true, budget });
    console.log(`autopilot ARMED for ${budget} step(s)`);
    break;
  }
  case "off":
    write({ armed: false, budget: 0 });
    console.log("autopilot OFF");
    break;
  case "spend": {
    const s = read();
    if (!s.armed || s.budget <= 0) break;
    write({ armed: true, budget: s.budget - 1 });
    break;
  }
  case "status":
  default: {
    const s = read();
    console.log(
      s.armed ? `ARMED — ${s.budget} step(s) remaining` : "OFF",
    );
  }
}
