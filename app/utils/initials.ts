/** "Ashley Jones" → "AJ". Up to two initials, upper-cased. */
export function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0))
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
