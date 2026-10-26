import type { ModelOption } from "#protocol/types.ts";

const efforts = [
  { id: "low", summary: "Fast responses with lighter reasoning" },
  { id: "medium", summary: "Balances speed and reasoning depth for everyday tasks" },
  { id: "high", summary: "Greater reasoning depth for complex problems" },
  { id: "xhigh", summary: "Extra high reasoning depth for complex problems" },
  { id: "max", summary: "Maximum reasoning depth for the hardest problems" },
];

export const demoModels: readonly ModelOption[] = [
  {
    id: "gpt-6.1-sol",
    title: "GPT-6.1-Sol",
    summary: "Latest workhorse model for coding and everyday work.",
    efforts,
    default_effort: "low",
    is_default: true,
    images: true,
  },
  {
    id: "gpt-6-luna",
    title: "GPT-6-Luna",
    summary: "Fast and affordable model for easier tasks.",
    efforts,
    default_effort: "medium",
    is_default: false,
    images: true,
  },
];
