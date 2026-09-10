import type {
  ComponentPropsWithRef,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
export function Input({
  className = "",
  ...props
}: ComponentPropsWithRef<"input">) {
  return <input className={`input ${className}`} {...props} />;
}
export function Textarea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`input textarea ${className}`} {...props} />;
}
export function Select({
  className = "",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`input select ${className}`} {...props} />;
}
