# Evaluating my-voice

STATUS: Evaluation procedure, prepared prompts and a returned test with visible highlights. No overall ZeroGPT score is recorded here. Read this file when testing or improving the skill, not during ordinary drafting.

## What a result means

Record compliance with the requested task, Josh's assessment of the voice and the actual ZeroGPT result separately. A low detector score does not establish that a piece sounds like Josh, and a stylistic improvement does not establish a score. A highlighted sentence identifies a result, not its cause. Describe an inferred cause as a hypothesis until a controlled comparison supports it.

The existing originals are in C:\Users\Joshua\Projects\Agentic Harness\skills\my-voice\samples\. Josh reports that his genuine writing consistently scores 0%. Treat that as his reported baseline; do not relabel it as a test you ran. Do not submit private writing to an external service without authorization to do so.

## Prepared checks

Use fresh conversations to avoid earlier failed drafts shaping the new ones. Ensure the updated skill text is installed in Harness before invoking /myvoice. Keep the provider and model fixed within a comparison, and record which reference files were actually read. A check that lacks real model output is a prepared check, not a completed evaluation.

1. Long creative assignment:

   /myvoice write a 900-1100 word opinion piece on why ham and cheese is objectively superior to turkey and cheese

   Check: it drafts without a compulsory personal-history questionnaire, stays within the word range, develops distinct reasons, and invents no autobiographical evidence. Assess the voice independently of the word count. Record a detector score only after actually obtaining one.

2. Explanatory opinion in another topic:

   /myvoice write a 250-350 word opinion piece arguing that replay review is more useful for improving at a competitive game than simply playing more matches. Explain why and address one limitation. Do not invent personal experiences.

   Check: the reasoning fits the supplied stance and the requested limitation. Useful factual explanations and transitions remain allowed. It does not copy an old sample's analogy, memorable sentence or biography.

3. Community register:

   /myvoice draft a 100-150 word Discord announcement. Free replay-review submissions reopen Monday. Members should use the replay-request channel, include a replay code and tell us what they want help with. Moderators can answer submission questions. Use only these facts.

   Check: it uses the announcement register, accurately preserves the supplied facts and permits an ordinary list. It adds no invented commitments, dates, links, giveaways or personal backstory. It need not force the terse ending of an opinion piece onto an announcement.

For each check, save the exact prompt and output, model/provider, guide version, reference filenames and word count. Ask Josh to identify particular phrases or passages that differ from his voice. Do not record an impression from the drafting model as independent validation. Keep generated drafts, detector reports and personal corrections in the local gitignored samples folder when saving them; never copy them into tracked documentation.

## Returned sandwich test, 2026-11-06

- Prompt: /myvoice write a 500 word opinion piece on why ham and cheese is objectively superior to turkey and cheese
- Model/provider: grok-4.7 through Cursor, from source-conversation metadata.
- Output: exactly 500 words using whitespace-separated word counting; six paragraphs.
- Instructions: Josh installed the revised skill text before this test. The drafting transcript reports loading the guide and originals, but its readable messages do not identify their exact versions or filenames.
- Detector evidence: Josh supplied a crop showing six highlighted sentences in two body paragraphs. The crop does not show the overall percentage or the results for the rest of the piece. Do not infer a total score or treat the unshown text as passed.
- Voice evidence: no separate judgment from Josh accompanied this result. The editorial observations in the correction comparisons are the reviewing assistant's assessment.
- Task compliance observed in the returned text: requested length met and no autobiographical anecdotes introduced. These facts do not establish voice fidelity.

Draft source: harness://conversation/f76ced8a-6501-42b8-855d-546350172f2b#d96b2098-a76e-4e7e-803c-e8b1cf34c32a

Returned full draft and screenshot: harness://conversation/10b25770-80b4-45b2-8051-494f77eca3c8#730ec226-3521-4425-b951-c06d06fd86a6

The earlier roughly 500-word test used gpt-6-luna through Codex (harness://conversation/cdb08ce6-b610-4dd5-8f6a-5e475d15e4db). A prior 900-1100-word test used claude-sonnet-5-5 through Claude Code (harness://conversation/eb72b925-990f-4404-85bb-d11c5ef4dc26). Model and length differences prevent attributing cross-run score differences to the guide alone. Keep Grok 4.7 and the 500-word task fixed for the next comparison with this run.

## Comparing approaches with existing originals

For calibration, use a genuine piece that is available to the evaluator and create a brief containing its substantive claims. Compare an AI attempt with the actual original and record a specific difference in expression or reasoning. Do not invent a supposedly corrected version in Josh's name. The ranked-systems pair is an existing starting point, although its two responses also differ in content.

For evaluation, reserve a different complete original. In a fresh drafting session, withhold it and its quotations, correction pairs and derived style notes. Supply a factual brief and the other reference samples. The evaluator can compare the generated response with the withheld original. A piece already visible in the session is not a blind holdout. If the reference packet cannot be separated cleanly, describe the comparison as calibration rather than independent evaluation.

Keep task, model and requested length fixed. Compare concise guidance plus authentic samples against the same material with a task-specific failed attempt and explanation. An optional further condition supplies the author's genuine opening. Evaluate the generated continuation separately so human text does not account for the apparent improvement. Avoid changing the prompt, model, length and sample set together; a better outcome would not identify which change helped.

Use several pieces before generalizing, retain unsuccessful attempts and record limitations. A fresh request or different model needs its own assessment. No fine-tuning, paid inference route or additional personal sample is a prerequisite for this procedure.

## Platform basis

Claude's documentation describes skills as instructions and supporting resources, including examples, with incremental testing. Harness's current skill is slash-invoked text that points to local files; those files must actually be read. Using the same provider name does not establish equivalent prompts or outputs between products.

- https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features
- https://support.claude.com/en/articles/12512198-how-to-create-custom-skills
- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
