import { expect, test } from "@playwright/test";
import { ADMIN, MOM, useAccount } from "./helpers.js";

/**
 * 관리자 → 미디어 생성 (#238 stage 1). The e2e server (FAKE_RUNTIME) answers for OpenRouter with a scripted fake
 * (`apps/server/src/media/fixture.ts`): a key starting with `sk-or-v1-e2e` is accepted, any other refused, and the
 * catalogs are small made-up lists — the real openrouter.ai is never called. The settings are server-wide, so the
 * write flow runs in one project only.
 */
test("the admin registers an OpenRouter key, picks a model per kind and sets the limits", async ({
  page,
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
  const image = form.getByLabel("이미지 모델");
  await expect(image.locator("option")).toHaveCount(3);
  await image.selectOption("fixture/image-one");
  await expect(form.getByTestId("media-model-image")).toContainText("$0.04/image");
  await expect(form.getByTestId("media-model-image")).toContainText("aspect_ratio: 1:1·16:9·9:16");
  await form.getByLabel("이미지 생성 켜기").check();
  await form.getByLabel("영상 모델").selectOption("fixture/video-one");
  await expect(form.getByTestId("media-model-video")).toContainText("최대 12초");
  await form.getByLabel("영상 생성 켜기").check();
  // Music lists only models with audio output.
  await expect(form.getByLabel("음악 모델").locator("option")).toHaveCount(2);

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

  // Turning a kind on needs a model (the save button waits for one).
  await form.getByLabel("음성 생성 켜기").check();
  await expect(form.getByText("켜려면 모델을 골라요.")).toBeVisible();
  await expect(form.getByRole("button", { name: "확인하고 저장" })).toBeDisabled();
  await form.getByLabel("음성 생성 켜기").uncheck();

  // Deleting the key: back to none (this e2e server has no .env key).
  page.once("dialog", (d) => void d.accept());
  await keyForm.getByRole("button", { name: "키 지우기" }).click();
  await expect(keyForm.getByTestId("media-key")).toContainText("키 없음");
});

test("a member gets neither the tab's data nor the key routes", async ({ page }) => {
  await useAccount(page, MOM);
  expect((await page.request.get("/api/admin/media")).status()).toBe(403);
  expect((await page.request.get("/api/admin/media/catalog/image")).status()).toBe(403);
});
