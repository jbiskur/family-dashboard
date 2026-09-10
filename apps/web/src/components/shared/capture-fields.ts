import { shoppingCategoryChoices } from "@/lib/shopping-categories";
import type { FormField } from "./form";

type Option = { value: string; label: string };
export const workAudience: FormField = {
  name: "visibility",
  label: "Who can see it?",
  defaultValue: "household",
  options: [
    { value: "household", label: "Household · shared" },
    { value: "personal", label: "Just me · private" },
  ],
};
export const workTitle: FormField = {
  name: "title",
  label: "What needs doing?",
  required: true,
  placeholder: "Water the plants…",
};
export const shoppingTitle: FormField = {
  name: "name",
  label: "What do we need?",
  required: true,
  placeholder: "Milk, bread, something nice…",
};
export function shoppingDetails(stores: Option[]): FormField[] {
  return [
    { name: "quantity", label: "Quantity or amount", placeholder: "2 cartons" },
    {
      name: "category",
      label: "Product category (optional)",
      colourChoices: shoppingCategoryChoices(),
    },
    { name: "note", label: "A note", type: "textarea" },
    {
      name: "offerStoreId",
      label: "Store offer",
      searchable: true,
      options: [{ value: "", label: "No store offer" }, ...stores],
    },
  ];
}
export function workDetails(assignees: Option[]): FormField[] {
  return [
    {
      name: "assigneeId",
      label: "Who's on it?",
      options: assignees,
      hint: "Personal to-dos can only be assigned to you.",
    },
    { name: "dueDate", label: "Due date (optional)", type: "date" },
    { name: "dueTime", optional: true, label: "Time (optional)", type: "time" },
    { name: "note", optional: true, label: "A helpful note", type: "textarea" },
    {
      name: "recurrenceUnit",
      optional: true,
      label: "Repeat",
      options: [
        { value: "", label: "Just this once" },
        { value: "day", label: "Every day" },
        { value: "week", label: "Every week" },
        { value: "month", label: "Every month" },
      ],
      hint: "Repeats follow the original due schedule, even when completed late.",
    },
    {
      name: "recurrenceInterval",
      optional: true,
      label: "Repeat interval",
      type: "number",
      min: "1",
      max: "365",
      defaultValue: "1",
      hint: "Used only when repeating. For example: every 2 weeks.",
    },
  ];
}
