type ClassPart = string | false | null | undefined;

/** Joins class names, skipping falsy parts: `cx("p-2", active && "bg-subtle", className)`. */
export function cx(...parts: ClassPart[]): string {
  return parts.filter(Boolean).join(" ");
}
