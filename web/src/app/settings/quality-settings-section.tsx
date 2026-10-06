import { useState } from "react";
import { QualityOptions } from "@/components/settings/quality-options";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SettingsDisclosure } from "@/components/settings/settings-disclosure";
import type { AudioLanguage, SettingsPatch } from "./settings-types";

const AUDIO_CHOICES: ReadonlyArray<{
  value: AudioLanguage;
  label: string;
  hint: string;
}> = [
  {
    value: "auto",
    label: "Japanese for anime, English for the rest",
    hint: "Anime comes in Japanese with English subtitles. An English dub is used when there is none.",
  },
  {
    value: "en",
    label: "English",
    hint: "English dubs first, anime included. English subtitles are used when there is no dub.",
  },
  {
    value: "any",
    label: "Any language",
    hint: "Do not check the language. Any source can download.",
  },
];

interface QualitySettings {
  preferredResolution: number;
  audioLanguage: AudioLanguage;
}

export function QualitySettingsSection({
  settings,
  saving,
  onSave,
}: {
  settings: QualitySettings;
  saving: boolean;
  onSave: (patch: SettingsPatch) => Promise<boolean>;
}) {
  const [resolution, setResolution] = useState(settings.preferredResolution);
  const [language, setLanguage] = useState(settings.audioLanguage);
  const [open, setOpen] = useState(true);

  return (
    <SettingsDisclosure
      id="quality-language"
      title="Quality and language"
      summary="Set the minimum video quality and preferred audio language."
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      <div className="space-y-5">
        <fieldset className="space-y-2" data-preferred-quality>
          <legend className="text-xs text-subtle-foreground">Minimum download quality</legend>
          <QualityOptions
            name="preferred-quality"
            value={resolution}
            onChange={setResolution}
          />
        </fieldset>
        <fieldset className="space-y-2" data-audio-language>
          <legend className="text-xs text-subtle-foreground">Audio language</legend>
          <RadioGroup
            name="audio-language"
            aria-label="Audio language"
            value={language === "english" ? "en" : language}
            onValueChange={(value) => {
              if (AUDIO_CHOICES.some((choice) => choice.value === value)) {
                setLanguage(value as AudioLanguage);
              }
            }}
            className="grid gap-2"
          >
            {AUDIO_CHOICES.map((choice) => (
              <Label
                key={choice.value}
                htmlFor={`audio-language-${choice.value}`}
                className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-background px-3 py-2.5 font-normal hover:border-brand"
              >
                <RadioGroupItem id={`audio-language-${choice.value}`} value={choice.value} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px] font-medium text-foreground">{choice.label}</span>
                  <span className="text-xs text-subtle-foreground">{choice.hint}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
          <p className="text-xs leading-relaxed text-subtle-foreground">
            Releases with unknown language download as usual. Only releases clearly marked as another language are skipped.
          </p>
        </fieldset>
        <div className="flex justify-end">
          <Button
            type="button"
            disabled={saving}
            onClick={() => void onSave({ preferredResolution: resolution, audioLanguage: language })}
          >
            Save quality and language
          </Button>
        </div>
      </div>
    </SettingsDisclosure>
  );
}
