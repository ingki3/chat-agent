import type {
  ChangeSettingsRequest,
  ChatSettings,
  CreateScheduleRequest,
  Schedule,
  ScheduleTiming,
  UpdateScheduleRequest,
} from "@agentlee/shared";

/**
 * The schedule form's pure parts (#55): what a save sends, and which skills the form lists. Kept apart from the
 * component so the order "chip choice settled → request" and the skill rows are tested on their own.
 */

export type FormValues = {
  name: string;
  prompt: string;
  timing: ScheduleTiming;
  timeZone: string;
  skills: string[];
  notify: boolean;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const asRequest = (c: ChatSettings): ChangeSettingsRequest => ({
  runtime: c.runtime,
  model: c.model,
  ...(c.effort ? { effort: c.effort } : {}),
  useShared: c.useShared,
});

/**
 * Saves the form. The chip's choice comes first, always: a preview still on its way is waited for and a failed one
 * throws before any request goes out — so a save never leaves with the defaults (or the old settings) while the
 * chip shows something else (review #108). `settled() === null`: the chip was not touched — no runtime·model is
 * sent and the server applies the creator's defaults (or keeps the schedule's own).
 */
export async function saveSchedule(
  v: FormValues,
  editing: Schedule | undefined,
  choice: { settled(): Promise<ChatSettings | null> },
  api: {
    create: (body: CreateScheduleRequest) => Promise<Schedule>;
    update: (id: string, body: UpdateScheduleRequest) => Promise<Schedule>;
  },
): Promise<Schedule> {
  const settled = await choice.settled();
  const picked = settled ? asRequest(settled) : {};
  if (!editing)
    return api.create({
      name: v.name,
      prompt: v.prompt,
      timing: v.timing,
      timeZone: v.timeZone,
      skills: v.skills,
      notify: v.notify,
      ...picked,
    });
  const body: UpdateScheduleRequest = { ...picked };
  if (v.name.trim() !== editing.name) body.name = v.name;
  if (v.prompt.trim() !== editing.prompt) body.prompt = v.prompt;
  if (!same(v.timing, editing.timing)) body.timing = v.timing;
  if (v.timeZone !== editing.timeZone) body.timeZone = v.timeZone;
  if (!same([...v.skills].sort(), [...editing.skills].sort())) body.skills = v.skills;
  if (v.notify !== editing.notify) body.notify = v.notify;
  return Object.keys(body).length ? api.update(editing.id, body) : editing;
}

export type SkillRow = { name: string; available: boolean; checked: boolean; disabled: boolean };

/**
 * The skill checkboxes: every skill the caller may use now, and the schedule's own ones that they may not use any
 * more (permission revoked) — shown as "사용할 수 없어요", checked so they can be removed, and not selectable again
 * once removed.
 */
export function skillRows(
  allowed: readonly string[],
  selected: readonly string[],
  own: readonly string[],
): SkillRow[] {
  const ok = new Set(allowed);
  const revoked = [...new Set([...own, ...selected])].filter((s) => !ok.has(s));
  return [
    ...allowed.map((name) => ({ name, available: true, checked: selected.includes(name), disabled: false })),
    ...revoked.map((name) => {
      const checked = selected.includes(name);
      return { name, available: false, checked, disabled: !checked };
    }),
  ];
}
