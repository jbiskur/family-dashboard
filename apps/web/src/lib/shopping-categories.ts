import {
  Carrot,
  Circle,
  Croissant,
  CupSoda,
  Fish,
  Milk,
  Package,
  Snowflake,
  Sparkles,
  Tag,
} from "lucide-react";

export const shoppingCategories = [
  { value: "", label: "No category", tone: "none", icon: Circle },
  {
    value: "Fruit & vegetables",
    label: "Fruit & vegetables",
    tone: "produce",
    icon: Carrot,
  },
  { value: "Dairy & eggs", label: "Dairy & eggs", tone: "dairy", icon: Milk },
  { value: "Meat & fish", label: "Meat & fish", tone: "meat", icon: Fish },
  { value: "Bakery", label: "Bakery", tone: "bakery", icon: Croissant },
  { value: "Pantry", label: "Pantry", tone: "pantry", icon: Package },
  { value: "Frozen", label: "Frozen", tone: "frozen", icon: Snowflake },
  { value: "Drinks", label: "Drinks", tone: "drinks", icon: CupSoda },
  { value: "Household", label: "Household", tone: "household", icon: Sparkles },
  { value: "Other", label: "Other", tone: "other", icon: Tag },
];
export function shoppingCategory(value: string) {
  return (
    shoppingCategories.find((category) => category.value === value) ?? {
      value,
      label: value,
      tone: "other",
      icon: Tag,
    }
  );
}
export function shoppingCategoryChoices(current = "") {
  return shoppingCategories.some((category) => category.value === current)
    ? shoppingCategories
    : [...shoppingCategories, shoppingCategory(current)];
}
