import type { Shared, SharedLink } from "#protocol/types.ts";

const pageOf = ({ title, site, description }: SharedLink): string | undefined => {
  const name = [title === undefined ? undefined : `“${title}”`, site === undefined ? undefined : `(${site})`]
    .filter(Boolean)
    .join(" ");
  const said = [name, description].filter(Boolean).join(": ");
  return said === "" ? undefined : `Its page: ${said}`;
};

// What Kumo reads of a message they shared from their phone's share sheet: the link with what its page says, the
// text they shared and their note, in words. Any other message is its text.
export const toSaid = (text: string, share: Shared | undefined): string => {
  if (share === undefined) return text;
  const { link, text: shared } = share;
  return [
    "(Shared from their phone's share sheet.)",
    link && `Link: ${link.url}`,
    link && pageOf(link),
    shared !== undefined && ["Text they shared:", ...shared.split("\n").map((line) => `> ${line}`)].join("\n"),
    text.trim() !== "" && `Their note: ${text}`,
  ]
    .filter(Boolean)
    .join("\n");
};
