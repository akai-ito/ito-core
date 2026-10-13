import type { Activity } from "#engine/engine.ts";
import type { Status } from "#protocol/types.ts";

const commandLabels = {
  read: "Reading files",
  search: "Searching files",
  list: "Browsing files",
  run: "Running a command",
} as const;

const withDetail = (status: Status, detail: string | undefined): Status => (detail ? { ...status, detail } : status);

export const toStatus = (activity: Activity): Status => {
  switch (activity.kind) {
    case "thinking": {
      return withDetail({ kind: "thinking", label: "Thinking" }, activity.heading);
    }
    case "web_search": {
      return withDetail({ kind: "working", label: "Searching the web" }, activity.query);
    }
    case "command": {
      return { kind: "working", label: commandLabels[activity.action] };
    }
    case "file_change": {
      return { kind: "working", label: "Editing files" };
    }
    case "tool": {
      return { kind: "working", label: "Working" };
    }
    case "compacting": {
      return { kind: "waiting", label: "Tidying up its notes" };
    }
  }
};

export const writingStatus: Status = { kind: "writing", label: "Writing" };

export const adjustingStatus: Status = { kind: "adjusting", label: "Adjusting to your message" };

export const stoppingStatus: Status = { kind: "stopping", label: "Stopping" };
