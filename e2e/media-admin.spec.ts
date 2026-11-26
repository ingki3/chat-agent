import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  ADMIN,
  MOM,
  authFile,
  csrf,
  newConversation,
  newMember,
  sendMessage,
  signIn,
  useAccount,
} from "./helpers.js";

/**
 * 관리자 → 미디어 생성 (#238 stage 1). The e2e server (FAKE_RUNTIME) answers for OpenRouter with a scripted fake
 * (`apps/server/src/media/fixture.ts`): a key starting with `sk-or-v1-e2e` is accepted, any other refused, and the
 * catalogs are small made-up lists — the real openrouter.ai is never called. The settings are server-wide, so the
 * write flow runs in one project only, and the tests of this file one after another (the chat test of stage 2
 * turns the kinds on with a key of its own after the admin flow has left none).
 */
test.describe.configure({ mode: "serial" });
let closeOther: (() => Promise<void>) | undefined;
test.afterEach(async () => {
  await closeOther?.();
  closeOther = undefined;
});

test("the admin registers an OpenRouter key, picks a model per kind and sets the limits", async ({
  page,
  baseURL,
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "server-wide settings: one project writes them");
  await useAccount(page, ADMIN);
  await page.goto("/admin?tab=media");
  const tab = page.getByRole("region", { name: "미디어 생성" });
  const keyForm = tab.getByRole("region", { name: "OpenRouter 키" });
  await expect(keyForm.getByTestId("media-key")).toContainText("키 없음");

  // A key OpenRouter refuses is not saved.
  await keyForm.getByLabel("OpenRouter API 키").fill("sk-or-v1-test-refused-000000000000000000000000");
  await keyForm.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(keyForm.getByRole("alert")).toContainText("OpenRouter가 이 키를 받지 않았어요");
  await expect(keyForm.getByTestId("media-key")).toContainText("키 없음");

  // A good one: only its last 4 characters and the limit left are shown.
  const key = "sk-or-v1-e2e-synthetic-000000000000000000000wxyz";
  await keyForm.getByLabel("OpenRouter API 키").fill(key);
  await keyForm.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(keyForm.getByTestId("media-key")).toContainText("관리자가 등록한 키");
  await expect(keyForm.getByTestId("media-key")).toContainText("wxyz");
  await expect(keyForm.getByTestId("media-key-remaining")).toHaveText("$87.50");
  await expect(page.locator("body")).not.toContainText(key.slice(0, 20));
  await expect(keyForm.getByLabel("OpenRouter API 키")).toHaveValue("");

  // Per kind: the catalog's models, with price and options.
  const form = tab.getByRole("form", { name: "미디어 생성 설정" });
  // Each kind's refresh button says which list it reloads.
  for (const label of ["이미지", "음성", "음악", "영상"])
    await expect(form.getByRole("button", { name: `${label} 목록 새로 고침` })).toBeEnabled();
  const image = form.getByLabel("이미지 모델");
  await expect(image.locator("option")).toHaveCount(3);
  await image.selectOption("fixture/image-one");
  await expect(form.getByTestId("media-model-image")).toContainText("$0.04/image");
  await expect(form.getByTestId("media-model-image")).toContainText("aspect_ratio: 1:1·16:9·9:16");
  await form.getByLabel("이미지 생성 켜기").check();
  await form.getByLabel("영상 모델").selectOption("fixture/video-one");
  await expect(form.getByTestId("media-model-video")).toContainText("최대 12초");
  await form.getByLabel("영상 생성 켜기").check();
  // Music lists only models with audio output — a voice-chat model last, saying what it is (#238 stage 2).
  await expect(form.getByLabel("음악 모델").locator("option")).toHaveCount(3);
  await form.getByLabel("음악 모델").selectOption("fixture/voice-chat");
  await expect(form.getByTestId("media-model-music")).toContainText("음성 대화 모델(음악 생성용 아님)");
  await form.getByLabel("음악 모델").selectOption("fixture/music-clip");
  await expect(form.getByTestId("media-model-music")).toContainText("$0.04/request");
  await form.getByLabel("음악 모델").selectOption("");
  // Speech: its price from the general Models API (the speech list has none), its unit not asserted.
  await form.getByLabel("음성 모델").selectOption("fixture/voice-one");
  await expect(form.getByTestId("media-model-speech")).toContainText("$0.000015/입력 단위 (단위 미확정");
  await form.getByLabel("음성 모델").selectOption("");

  await expect(form.getByLabel("1인당 하루 비용 한도 (USD)")).toHaveValue("50");
  await expect(form.getByLabel("한 번 실행에서 이미지 최대 횟수")).toHaveValue("4");
  await expect(form.getByLabel("한 번 실행에서 음성 최대 횟수")).toHaveValue("3");
  await expect(form.getByLabel("한 번 실행에서 영상 최대 횟수")).toHaveValue("1");
  await expect(form.getByLabel("영상 기본 길이 (초)")).toHaveValue("8");
  await form.getByLabel("1인당 하루 비용 한도 (USD)").fill("20");
  await form.getByLabel("한 번 실행에서 이미지 최대 횟수").fill("2");
  await form.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(form.getByRole("status")).toHaveText("저장했어요.");

  // Kept after a reload.
  await page.reload();
  await expect(form.getByLabel("이미지 모델")).toHaveValue("fixture/image-one");
  await expect(form.getByLabel("이미지 생성 켜기")).toBeChecked();
  await expect(form.getByLabel("영상 생성 켜기")).toBeChecked();
  await expect(form.getByLabel("음성 생성 켜기")).not.toBeChecked();
  await expect(form.getByLabel("1인당 하루 비용 한도 (USD)")).toHaveValue("20");
  await expect(form.getByLabel("한 번 실행에서 이미지 최대 횟수")).toHaveValue("2");

  // Review r5: right after a save, only another field is edited and saved — the first save's value stays.
  await form.getByLabel("1인당 하루 비용 한도 (USD)").fill("15");
  await form.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(form.getByRole("status")).toHaveText("저장했어요.");
  await form.getByLabel("한 번 실행에서 이미지 최대 횟수").fill("3");
  await form.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(form.getByRole("status")).toHaveText("저장했어요.");
  await page.reload();
  await expect(form.getByLabel("1인당 하루 비용 한도 (USD)")).toHaveValue("15");
  await expect(form.getByLabel("한 번 실행에서 이미지 최대 횟수")).toHaveValue("3");

  // A save made from an older revision (another tab saved meanwhile) is refused; the admin's value stays.
  const version = (await (await page.request.get("/api/admin/media")).json()) as {
    settingsRevision: string;
    settings: unknown;
  };
  const otherSave = await page.request.put("/api/admin/media/settings", {
    headers: csrf(baseURL!),
    data: { settings: version.settings, expectedRevision: version.settingsRevision },
  });
  expect(otherSave.status()).toBe(200);
  await form.getByLabel("1인당 하루 비용 한도 (USD)").fill("12");
  await form.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(form.getByRole("alert")).toContainText("다른 곳에서 설정이 바뀌었어요");
  // Once the read after the refusal is here, it says so and the re-save opens (review r10).
  await expect(form.getByRole("alert")).toContainText("최신 값을 불러왔어요");
  await expect(form.getByRole("button", { name: "이 값으로 다시 저장" })).toBeEnabled();
  await expect(form.getByLabel("1인당 하루 비용 한도 (USD)")).toHaveValue("12");
  await form.getByRole("button", { name: "이 값으로 다시 저장" }).click();
  await expect(form.getByRole("status")).toHaveText("저장했어요.");
  await page.reload();
  await expect(form.getByLabel("1인당 하루 비용 한도 (USD)")).toHaveValue("12");

  // Review r7: the menu is left and entered again while a save is on its way — the form mounted then settles it.
  const limit = form.getByLabel("1인당 하루 비용 한도 (USD)");
  const reenter = async () => {
    await page.getByRole("tab", { name: "사용자" }).click();
    await page.getByRole("tab", { name: "미디어 생성" }).click();
  };
  let release: () => void = () => {};
  const held = (answer?: { status: number; body: unknown }) =>
    page.route("**/api/admin/media/settings", async (route) => {
      await new Promise<void>((r) => (release = r));
      if (answer) await route.fulfill({ status: answer.status, json: answer.body });
      else await route.continue();
    });
  await held();
  await limit.fill("33");
  await form.getByRole("button", { name: "확인하고 저장" }).click();
  await reenter();
  await expect(form.getByRole("status")).toHaveText("저장하는 중…");
  await expect(limit).toHaveValue("33");
  await expect(limit).toBeDisabled();
  release();
  await expect(form.getByRole("status")).toHaveText("저장했어요.");
  await expect(limit).toHaveValue("33");
  await expect(limit).toBeEnabled();
  await page.unroute("**/api/admin/media/settings");
  // Refused after re-entry: the error shows in the form mounted now, the admin's value stays.
  await held({ status: 409, body: { error: "media_settings_changed" } });
  await limit.fill("44");
  await form.getByRole("button", { name: "확인하고 저장" }).click();
  await reenter();
  await expect(limit).toBeDisabled();
  release();
  await expect(form.getByRole("alert")).toContainText("다른 곳에서 설정이 바뀌었어요");
  await expect(limit).toHaveValue("44");
  await expect(limit).toBeEnabled();
  await page.unroute("**/api/admin/media/settings");
  // "최신 값 불러오기" offline: nothing arrives, so the draft stays (and a retry is offered).
  await page.context().setOffline(true);
  await form.getByRole("button", { name: "최신 값 불러오기" }).click();
  await expect(form.getByRole("alert").filter({ hasText: "최신 값을 불러오지 못했어요" })).toBeVisible();
  await expect(limit).toHaveValue("44");
  // Review r12: the status read waits for the connection — said as such, not as a failure to retry.
  await expect(page.getByTestId("media-status-paused")).toBeVisible();
  await expect(page.getByTestId("media-status-error")).toHaveCount(0);
  await page.context().setOffline(false);
  // Review r8: the read held back, the menu re-entered — a save cannot start while the read holds the slot.
  const releases: (() => void)[] = [];
  await page.route("**/api/admin/media", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await new Promise<void>((r) => releases.push(r));
    await route.continue().catch(() => {});
  });
  await form.getByRole("button", { name: "최신 값 불러오기" }).click();
  await reenter();
  await expect(form.getByRole("button", { name: "이 값으로 다시 저장" })).toBeDisabled();
  await expect(limit).toBeDisabled();
  await expect(limit).toHaveValue("44");
  releases.splice(0).forEach((r) => r());
  await expect(limit).toHaveValue("33");
  await expect(limit).toBeEnabled();
  await page.unroute("**/api/admin/media");

  // Turning a kind on needs a model (the save button waits for one).
  await form.getByLabel("음성 생성 켜기").check();
  await expect(form.getByText("켜려면 모델을 골라요.")).toBeVisible();
  await expect(form.getByRole("button", { name: "확인하고 저장" })).toBeDisabled();
  await form.getByLabel("음성 생성 켜기").uncheck();

  // Another tab swaps the key (review r3): this tab still shows wxyz. A manual refresh is refused for the old key
  // generation, the status is read again, and the new key's own list shows — never its list next to wxyz.
  // The other tab names the generation it shows, as this screen does.
  const generation = async () =>
    ((await (await page.request.get("/api/admin/media")).json()) as { key: { generation: string } }).key
      .generation;
  const other = await page.request.put("/api/admin/media/key", {
    headers: csrf(baseURL!),
    data: { key: "sk-or-v1-e2e-synthetic-other-tab-00000000000dddd", expectedGeneration: await generation() },
  });
  expect(other.status()).toBe(200);
  await expect(keyForm.getByTestId("media-key")).toContainText("wxyz");
  await form.getByRole("button", { name: "이미지 목록 새로 고침" }).click();
  await expect(keyForm.getByTestId("media-key")).toContainText("dddd");
  await expect(keyForm.getByTestId("media-key")).not.toContainText("wxyz");
  await expect(form.getByTestId("media-model-image")).toContainText("$0.04/image");
  await expect(form.getByTestId("media-catalog-error-image")).toHaveCount(0);

  // Deleting the key: back to none (this e2e server has no .env key).
  page.once("dialog", (d) => void d.accept());
  await keyForm.getByRole("button", { name: "키 지우기" }).click();
  await expect(keyForm.getByTestId("media-key")).toContainText("키 없음");
  // Nothing of the deleted key's lists stays on screen (review r2): no models, prices or list source — only the
  // saved choice itself, marked as not in a list.
  await expect(form.getByTestId("media-model-image")).toHaveCount(0);
  await expect(form.getByTestId("media-catalog-source-image")).toHaveCount(0);
  await expect(image.locator("option")).toHaveText(["모델 고르기", "fixture/image-one (목록에 없음)"]);
  await expect(form.getByLabel("음악 모델").locator("option")).toHaveText(["모델 고르기"]);
  // A new key reads its own lists.
  await keyForm.getByLabel("OpenRouter API 키").fill("sk-or-v1-e2e-synthetic-second-0000000000000vvvv");
  await keyForm.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(keyForm.getByTestId("media-key")).toContainText("vvvv");
  await expect(form.getByTestId("media-model-image")).toContainText("$0.04/image");
  // Another tab deletes it: a manual refresh here ends in "키 없음" with no list and no error left over.
  const shownGeneration = await generation();
  expect(
    (
      await page.request.delete("/api/admin/media/key", {
        headers: csrf(baseURL!),
        data: { expectedGeneration: shownGeneration },
      })
    ).status(),
  ).toBe(200);
  await form.getByRole("button", { name: "이미지 목록 새로 고침" }).click();
  await expect(keyForm.getByTestId("media-key")).toContainText("키 없음");
  await expect(form.getByTestId("media-model-image")).toHaveCount(0);
  await expect(form.getByTestId("media-catalog-source-image")).toHaveCount(0);
  await expect(form.getByTestId("media-catalog-error-image")).toHaveCount(0);

  // Review r6: a write held back offline sends what was clicked, not what is on screen when it goes out.
  const otherTab = await browser.newContext({ storageState: authFile(ADMIN), baseURL: baseURL! });
  closeOther = () => otherTab.close();
  const keyInput = keyForm.getByLabel("OpenRouter API 키");
  const serverLast4 = async () =>
    ((await (await otherTab.request.get("/api/admin/media")).json()) as { key: { last4: string | null } }).key
      .last4;
  await keyInput.fill("sk-or-v1-e2e-synthetic-offline-00000000000bbbb");
  await page.context().setOffline(true);
  await keyForm.getByRole("button", { name: "확인하고 저장" }).click();
  await keyInput.fill("sk-or-v1-e2e-synthetic-offline-00000000000cccc");
  await page.context().setOffline(false);
  await expect(keyForm.getByTestId("media-key")).toContainText("bbbb");
  expect(await serverLast4()).toBe("bbbb");
  // The newer input is kept (only the saved key is cleared).
  await expect(keyInput).toHaveValue("sk-or-v1-e2e-synthetic-offline-00000000000cccc");
  await keyInput.fill("");

  // Delete of bbbb confirmed offline; meanwhile the other tab puts eeee in. Online again, the delete is refused
  // (it names bbbb's generation) and eeee stays.
  await page.context().setOffline(true);
  page.once("dialog", (d) => void d.accept());
  await keyForm.getByRole("button", { name: "키 지우기" }).click();
  const g = (
    (await (await otherTab.request.get("/api/admin/media")).json()) as { key: { generation: string } }
  ).key.generation;
  const swap = await otherTab.request.put("/api/admin/media/key", {
    headers: csrf(baseURL!),
    data: { key: "sk-or-v1-e2e-synthetic-offline-00000000000eeee", expectedGeneration: g },
  });
  expect(swap.status()).toBe(200);
  await page.context().setOffline(false);
  await expect(keyForm.getByTestId("media-key")).toContainText("eeee");
  expect(await serverLast4()).toBe("eeee");
  page.once("dialog", (d) => void d.accept());
  await keyForm.getByRole("button", { name: "키 지우기" }).click();
  await expect(keyForm.getByTestId("media-key")).toContainText("키 없음");
});

test("a member gets neither the tab's data nor the key routes", async ({ page }) => {
  await useAccount(page, MOM);
  expect((await page.request.get("/api/admin/media")).status()).toBe(403);
  expect((await page.request.get("/api/admin/media/catalog/image")).status()).toBe(403);
});

test("stage 2: a generated image shows in the reply, generated speech plays in an audio player", async ({
  page,
  browser,
  baseURL,
}, info) => {
  test.skip(info.project.name !== "desktop", "server-wide settings: one project writes them");
  // The admin: a key of the fixture OpenRouter, image and speech on.
  const admin = await browser.newContext({ storageState: authFile(ADMIN), baseURL: baseURL! });
  closeOther = () => admin.close();
  const status = (await (await admin.request.get("/api/admin/media")).json()) as {
    key: { generation: string };
    settings: Record<string, unknown> & { kinds: Record<string, unknown> };
  };
  const put = await admin.request.put("/api/admin/media/key", {
    headers: csrf(baseURL!),
    data: {
      key: "sk-or-v1-e2e-synthetic-chat-000000000000000chat",
      expectedGeneration: status.key.generation,
    },
  });
  expect(put.status()).toBe(200);
  const now = (await put.json()) as { settingsRevision: string; settings: typeof status.settings };
  const saved = await admin.request.put("/api/admin/media/settings", {
    headers: csrf(baseURL!),
    data: {
      settings: {
        ...now.settings,
        kinds: {
          ...now.settings.kinds,
          image: { enabled: true, model: "fixture/image-one" },
          speech: { enabled: true, model: "fixture/voice-one" },
        },
      },
      expectedRevision: now.settingsRevision,
    },
  });
  expect(saved.status(), await saved.text()).toBe(200);

  // A family member of its own asks for an image, then for speech.
  await signIn(page, baseURL!, await newMember(browser, baseURL!, "media-chat"));
  const conv = await newConversation(page.request, baseURL!, `미디어 ${crypto.randomUUID().slice(0, 8)}`);
  await page.goto(`/c/${conv.id}`);
  await sendMessage(page, "/image 노을 진 바다 위 작은 배");
  const imageReply = page.getByTestId("assistant").last();
  await expect(imageReply).toHaveAttribute("data-status", "complete");
  const img = imageReply.getByTestId("file-ref-image");
  await expect(img).toBeVisible();
  // Really loaded through the inline route (a 64×64 PNG of the fixture).
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(64);
  expect(await img.getAttribute("src")).toMatch(/^\/api\/files\/[^/]+\/content\?inline=1$/);
  await expect(imageReply.getByTestId("file-ref")).toContainText(/image-.*\.png/);

  await sendMessage(page, "/speech 안녕하세요, 오늘 날씨가 좋네요.");
  const speechReply = page.getByTestId("assistant").last();
  await expect(speechReply).toHaveAttribute("data-status", "complete");
  const audio = speechReply.getByTestId("file-ref-audio");
  await expect(audio).toBeVisible();
  await expect(audio).toHaveAttribute("controls", "");
  // The player read the MP3's header (served inline, the page's CSP lets media from 'self').
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => (el.error ? -1 : el.readyState)), {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(1);
  await expect(speechReply.getByTestId("file-ref")).toContainText(/speech-.*\.mp3/);

  // Back off for the other specs: kinds off, key removed.
  const after = (await (await admin.request.get("/api/admin/media")).json()) as {
    key: { generation: string };
    settingsRevision: string;
    settings: typeof status.settings;
  };
  expect(
    (
      await admin.request.put("/api/admin/media/settings", {
        headers: csrf(baseURL!),
        data: {
          settings: {
            ...after.settings,
            kinds: {
              ...after.settings.kinds,
              image: { enabled: false, model: "fixture/image-one" },
              speech: { enabled: false, model: "fixture/voice-one" },
            },
          },
          expectedRevision: after.settingsRevision,
        },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await admin.request.delete("/api/admin/media/key", {
        headers: csrf(baseURL!),
        data: { expectedGeneration: after.key.generation },
      })
    ).status(),
  ).toBe(200);
});

/**
 * 영상 생성 (#238 stage 3), in this file so it runs after the admin flow with the server-wide settings to itself: the
 * fixture OpenRouter's scripted video jobs move one step a second (`fixture.ts`) and its scripted ffprobe checks the
 * MP4 — nothing real is called.
 */
test("stage 3: a video card is approved, follows its job and plays the video in place; offline it waits", async ({
  page,
  browser,
  baseURL,
}, info) => {
  test.skip(info.project.name !== "desktop", "server-wide settings: one project writes them");
  const admin = await browser.newContext({ storageState: authFile(ADMIN), baseURL: baseURL! });
  closeOther = () => admin.close();
  const status = (await (await admin.request.get("/api/admin/media")).json()) as {
    key: { generation: string };
    settings: Record<string, unknown> & { kinds: Record<string, unknown> };
  };
  const put = await admin.request.put("/api/admin/media/key", {
    headers: csrf(baseURL!),
    data: {
      key: "sk-or-v1-e2e-synthetic-video-00000000000000video",
      expectedGeneration: status.key.generation,
    },
  });
  expect(put.status()).toBe(200);
  const now = (await put.json()) as { settingsRevision: string; settings: typeof status.settings };
  const saved = await admin.request.put("/api/admin/media/settings", {
    headers: csrf(baseURL!),
    data: {
      settings: {
        ...now.settings,
        kinds: { ...now.settings.kinds, video: { enabled: true, model: "fixture/video-one" } },
      },
      expectedRevision: now.settingsRevision,
    },
  });
  expect(saved.status(), await saved.text()).toBe(200);

  await signIn(page, baseURL!, await newMember(browser, baseURL!, "media-video"));
  const conv = await newConversation(page.request, baseURL!, `영상 ${crypto.randomUUID().slice(0, 8)}`);
  await page.goto(`/c/${conv.id}`);
  await sendMessage(page, "/video 노을 진 바다 위 작은 배");
  const reply = page.getByTestId("assistant").last();
  await expect(reply).toHaveAttribute("data-status", "complete");
  const card = reply.getByTestId("video-card");
  // The card: what would be made and the most it may cost — nothing made yet.
  await expect(card.getByTestId("video-card-status")).toHaveText("승인을 기다려요");
  await expect(card.getByTestId("video-card-duration")).toHaveText("8초");
  await expect(card.getByTestId("video-card-resolution")).toHaveText("720p");
  await expect(card.getByTestId("video-card-cost")).toHaveText("최대 $0.48");
  await expect(card).toContainText("승인한 뒤에는 취소할 수 없어요");
  await expect(card).toContainText("켜짐 (모델 기본값)");

  // Offline: 승인 waits for the connection.
  await page.context().setOffline(true);
  await expect(card.getByTestId("video-card-approve")).toBeDisabled();
  await expect(card.getByTestId("video-card-offline")).toBeVisible();
  await page.context().setOffline(false);
  await expect(card.getByTestId("video-card-approve")).toBeEnabled();

  await card.getByTestId("video-card-approve").click();
  // The job follows live: submitted, made, downloaded and checked — then the player (or, where the browser cannot
  // play MP4, the download).
  await expect(card.getByTestId("video-card-status")).toHaveText("완성됐어요", { timeout: 30_000 });
  await expect(card.getByTestId("video-card-cost")).toHaveText("$0.30");
  const download = card.getByTestId("video-card-download");
  await expect(download).toContainText(/video-.*\.mp4/);
  // The player — or, where the browser cannot play it (no MP4 support, or a file it cannot decode: the fixture's MP4
  // holds no frames), the download only.
  const player = card.getByTestId("video-card-video");
  await expect(player.or(card.getByTestId("video-card-no-player"))).toBeVisible();
  if (await player.count()) {
    await expect(player).toHaveAttribute("controls", "");
    expect(await player.getAttribute("src")).toMatch(/^\/api\/files\/[^/]+\/content\?inline=1$/);
  }
  // Served inline: only because a video job checked and stored it.
  const href = (await download.getAttribute("href"))!;
  const inline = await page.request.get(`${href}?inline=1`);
  expect(inline.status()).toBe(200);
  expect(inline.headers()["content-type"]).toBe("video/mp4");
  expect(inline.headers()["content-disposition"]).toMatch(/^inline/);

  // A second card is closed without approving it.
  await sendMessage(page, "/video 눈 내리는 숲");
  const second = page.getByTestId("assistant").last().getByTestId("video-card");
  await expect(second.getByTestId("video-card-status")).toHaveText("승인을 기다려요");
  await second.getByTestId("video-card-dismiss").click();
  await expect(second.getByTestId("video-card-status")).toHaveText("닫았어요");

  // Back off for the other specs: video off, key removed.
  const after = (await (await admin.request.get("/api/admin/media")).json()) as {
    key: { generation: string };
    settingsRevision: string;
    settings: typeof status.settings;
  };
  expect(
    (
      await admin.request.put("/api/admin/media/settings", {
        headers: csrf(baseURL!),
        data: {
          settings: {
            ...after.settings,
            kinds: { ...after.settings.kinds, video: { enabled: false, model: "fixture/video-one" } },
          },
          expectedRevision: after.settingsRevision,
        },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await admin.request.delete("/api/admin/media/key", {
        headers: csrf(baseURL!),
        data: { expectedGeneration: after.key.generation },
      })
    ).status(),
  ).toBe(200);
});

test("stage 3: the admin cannot choose a video model priced in tokens (no bound from a length)", async ({
  page,
  baseURL,
}, info) => {
  test.skip(info.project.name !== "desktop", "server-wide settings: one project writes them");
  await useAccount(page, ADMIN);
  const status = (await (await page.request.get("/api/admin/media")).json()) as {
    key: { generation: string };
  };
  expect(
    (
      await page.request.put("/api/admin/media/key", {
        headers: csrf(baseURL!),
        data: {
          key: "sk-or-v1-e2e-synthetic-tokens-0000000000000tokn",
          expectedGeneration: status.key.generation,
        },
      })
    ).status(),
  ).toBe(200);
  await page.goto("/admin?tab=media");
  const form = page
    .getByRole("region", { name: "미디어 생성" })
    .getByRole("form", { name: "미디어 생성 설정" });
  await form.getByLabel("영상 모델").selectOption("fixture/video-tokens");
  await form.getByLabel("영상 생성 켜기").check();
  await form.getByRole("button", { name: "확인하고 저장" }).click();
  await expect(form.getByRole("alert")).toContainText(
    "영상: 이 영상 모델은 토큰(video_tokens) 단위로 과금돼",
  );
  await page.reload();
  await expect(form.getByLabel("영상 생성 켜기")).not.toBeChecked();
  const after = (await (await page.request.get("/api/admin/media")).json()) as {
    key: { generation: string };
  };
  expect(
    (
      await page.request.delete("/api/admin/media/key", {
        headers: csrf(baseURL!),
        data: { expectedGeneration: after.key.generation },
      })
    ).status(),
  ).toBe(200);
});
