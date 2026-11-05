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

// The approval card shows the plan. The chat bubble keeps only what is not
// that plan: notes outside the tags, with the tagged body and one extra
// verbatim copy removed. A plan still being written stays hidden too.
export function visibleReply(text = "", plan = "") {
  if (typeof text !== "string") return "";
  const visible = text
    .replace(/<proposed_plan>[\s\S]*?<\/proposed_plan>/g, "")
    .replace(/<proposed_plan>[\s\S]*$/, "");
  const proposal = typeof plan === "string" ? plan.trim() : "";
  if (!proposal) return visible.trim();
  if (visible.trim() === proposal) return "";
  const at = visible.indexOf(proposal);
  if (at === -1) return visible.trim();
  return (visible.slice(0, at) + visible.slice(at + proposal.length)).trim();
}

export const PLAN_INSTRUCTIONS =
  "When you finish a proposal in Plan mode, put the complete plan only inside <proposed_plan> tags. Do not repeat that plan in the message. Harness shows the tagged proposal in the approval card and hides it from the chat. A short note outside the tags is fine when it is not the plan, such as what changed. Do not put progress checklists or clarification questions in these tags.";

// Feedback on a plan asks for a complete new proposal, so the revision gets
// its own card and review. The change note stays outside the tags.
export function planRevisionRequest(feedback) {
  return `Revise the plan based on this feedback:\n\n${feedback}\n\nFirst say briefly what you changed and why. That note stays outside the tags. Then put the complete revised plan only inside <proposed_plan> tags, and do not repeat the plan in the message.`;
}
