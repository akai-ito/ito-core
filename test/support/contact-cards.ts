// vCards as iCloud keeps them, with fictional people.

export const photo = `PHOTO;ENCODING=b;TYPE=JPEG:${"/9j/4AAQSkZJRgABAQAAAQABAAD".repeat(6)}`;

export const folded = (line: string): string =>
  (line.match(/.{1,74}/gu) ?? []).map((piece, index) => (index === 0 ? piece : ` ${piece}`)).join("\r\n");

// Clara's card as an iPhone writes it into iCloud.
export const claraCard = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "PRODID:-//Apple Inc.//iPhone OS 26.0//EN",
  "N:Voss;Clara;;;",
  "FN:Clara Voss",
  "ORG:Northwind;Product;",
  "TITLE:Head of Product",
  "EMAIL;type=INTERNET;type=WORK;type=pref:clara.voss@northwind.example",
  "item1.EMAIL;type=INTERNET:clara@voss.example",
  "item1.X-ABLabel:_$!<Other>!$_",
  "TEL;type=CELL;type=VOICE;type=pref:+44 7700 900123",
  "item2.TEL:020 7946 0000",
  "item2.X-ABLabel:studio",
  "item3.ADR;type=HOME;type=pref:;;12 Harbour Row;London;;E14 5AB;United Kingdom",
  "item3.X-ABADR:gb",
  "BDAY;X-APPLE-OMIT-YEAR=1604:1604-04-12",
  "item4.X-ABRELATEDNAMES:Mira",
  "item4.X-ABLabel:_$!<Sister>!$_",
  "item5.X-ABDATE;type=pref:2019-06-20",
  "item5.X-ABLabel:_$!<Anniversary>!$_",
  String.raw`NOTE:Met at the Halcyon offsite\, 2024.\nLast caught up: Sep 2026 · coffee`,
  folded(photo),
  "UID:7C1D4E2A-1111-4C3B-9F00-ABCDEF012345",
  "X-ABUID:7C1D4E2A-1111-4C3B-9F00-ABCDEF012345:ABPerson",
  "REV:2026-09-01T10:00:00Z",
  "END:VCARD",
  "",
].join("\r\n");

export const leoCard = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  "FN:Leo Marsh",
  "N:Marsh;Leo;;;",
  "EMAIL;TYPE=home:leo@halcyon.example",
  "TEL;VALUE=uri;TYPE=cell:tel:+44-7700-900456",
  "BDAY:--1105",
  "RELATED;TYPE=sibling;VALUE=text:Tess Harlow",
  "UID:urn:uuid:4f2b9a10-2222-4c3b-9f00-abcdef012345",
  "END:VCARD",
  "",
].join("\r\n");
