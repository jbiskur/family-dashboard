"use client";
import { Check, type LucideIcon } from "lucide-react";
import { Button } from "../ui/button";

export type ColourChoice = {
  value: string;
  label: string;
  tone: string;
  icon: LucideIcon;
};
export function ColourTag({ choice }: { choice: ColourChoice }) {
  const Icon = choice.icon;
  return (
    <span className={`category-tag category-${choice.tone}`}>
      <Icon size={13} aria-hidden="true" />
      {choice.label}
    </span>
  );
}
export function ColourChoiceField({
  id,
  label,
  value,
  choices,
  onChange,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  choices: ColourChoice[];
  onChange: (value: string) => void;
  describedBy?: string;
}) {
  return (
    <fieldset id={id} aria-describedby={describedBy} className="colour-field">
      <legend>{label}</legend>
      <div className="colour-choices">
        {choices.map((choice) => {
          const Icon = choice.icon;
          return (
            <Button
              key={choice.value}
              type="button"
              variant="ghost"
              aria-pressed={value === choice.value}
              className={`colour-choice category-${choice.tone}`}
              onClick={() => onChange(choice.value)}
            >
              <Icon size={17} aria-hidden="true" />
              <span>{choice.label}</span>
              {value === choice.value && <Check size={15} aria-hidden="true" />}
            </Button>
          );
        })}
      </div>
    </fieldset>
  );
}
