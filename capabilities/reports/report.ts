import path from "node:path";

export type Screenshot = { readonly file: string; readonly shows: string };

export type Report = {
  readonly title?: string;
  readonly body: string;
  readonly screenshots: readonly Screenshot[];
  readonly issue?: number;
};

export type Versions = { readonly ito: string; readonly engine: string };

export type Stored = { readonly shows: string; readonly url: string };

export const uploadsFolder = "uploads";

export const toQuestion = ({ issue }: Report): string =>
  issue === undefined ? "File this on GitHub?" : `Add this to issue #${String(issue)} on GitHub?`;

export const toOptions = ({ issue }: Report): readonly { readonly label: string; readonly acts?: true }[] => [
  { label: issue === undefined ? "File it" : "Add it", acts: true },
  { label: "Don't" },
];

export const toPreview = ({ title, body, screenshots, issue }: Report, repository: string): string =>
  [
    ...(title === undefined ? [] : [title, ""]),
    body,
    "",
    ...(screenshots.length === 0 ? [] : [`Screenshots: ${screenshots.map(({ shows }) => shows).join("; ")}`]),
    issue === undefined ? `Public, on ${repository}.` : `Public, on ${repository}#${String(issue)}.`,
  ].join("\n");

export const toBody = (body: string, stored: readonly Stored[], { ito, engine }: Versions): string =>
  [body, ...stored.map(({ shows, url }) => `![${shows}](${url})`), `Ito ${ito} · ${engine}`].join("\n\n");

export const uploadPath = (workspace: string, file: string): string | undefined => {
  const uploads = path.join(workspace, uploadsFolder);
  const resolved = path.resolve(workspace, file);
  return resolved.startsWith(`${uploads}${path.sep}`) ? resolved : undefined;
};

export const mediaPath = (sha256: string, file: string, now: Date): string =>
  [
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    `${sha256.slice(0, 16)}${path.extname(file).toLowerCase()}`,
  ].join("/");
