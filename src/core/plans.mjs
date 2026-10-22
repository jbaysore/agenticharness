export function taggedProposal(text = "") {
  const matches = [
    ...text.matchAll(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/g),
  ];
  return matches.at(-1)?.[1]?.trim() || null;
}

export function proposalText(text) {
  return typeof text === "string"
    ? (taggedProposal(text) ?? (text.trim() || null))
    : null;
}

export const PLAN_INSTRUCTIONS =
  "When you finish a proposal in Plan mode, include the complete plan inside <proposed_plan> tags in your final message. Harness displays that exact proposal in its approval card. Do not put progress checklists or clarification questions in these tags.";
