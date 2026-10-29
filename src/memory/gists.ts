export const gistGuide =
  "What the page is now, in one line: a journal day's headline, such as “Home from Ljubljana; Bora's first " +
  "sub-two”; who someone is to the person, such as “Recruiter on the QRT process”; where a project or goal " +
  "stands; or what anything else is now.";

export const toOneLine = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();
