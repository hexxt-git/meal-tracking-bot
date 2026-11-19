import { externalFetch, setExternalFetch } from "./support/env.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { respond, retryMediaWait } from "../src/bot/assistant.ts";
import type { User } from "../src/db/index.ts";
import type { Message } from "../src/telegram/types.ts";
import type { View } from "../src/bot/ui.ts";
import { buttons, fakeCtx, user } from "./support/fakes.ts";
import { fakeModel } from "./support/model.ts";

function setup(patch: Partial<User> = {}) {
  const f = fakeCtx({
    user: user({
      aiSettings: {
        custom: {
          enabled: true,
          baseUrl: "https://fake.example/v1",
          model: "fake-model",
          images: true,
        },
      } as never,
      ...patch,
    }),
  });
  f.state.providerSecret = { token: "tok", headers: {} };
  return f;
}

/** Telegram's file host fails like a network error while `down.value` is true; the model API answers as scripted. */
function telegramFiles(script: Parameters<typeof fakeModel>[0]) {
  const model = fakeModel(script);
  const modelFetch = externalFetch!;
  const down = { value: true };
  setExternalFetch((input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.telegram.org/file/"))
      return modelFetch(input, init);
    if (down.value) return Promise.reject(new TypeError("connection reset"));
    return Promise.resolve(new Response(new Uint8Array([0xff, 0xd8, 0xff])));
  });
  return { model, down };
}

const photo = (caption = ""): Message =>
  ({
    message_id: 500,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 1, type: "private" },
    from: { id: 1 },
    caption,
    photo: [{ file_id: "file-1", width: 800, height: 600 }],
  }) as Message;

const text = (v: View | string) => (typeof v === "string" ? v : v.text);

Deno.test(
  "a photo Telegram won't deliver is announced once, retried silently and logged once it arrives",
  async () => {
    const { model, down } = telegramFiles([
      [
        {
          name: "log_meal",
          args: {
            description: "Toast",
            items: [
              {
                name: "Toast",
                portion: "1 slice",
                kcal: 80,
                protein_g: 3,
                carbs_g: 15,
                fat_g: 1,
              },
            ],
          },
        },
        { name: "reply", args: { text: "Logged toast." } },
      ],
    ]);
    const { ctx, state, sent } = setup();
    await respond(ctx, photo("breakfast"));
    assertEquals(sent.length, 1);
    assertStringIncludes(text(sent[0]), "isn't delivering your photo");
    const wait = state.user.mediaWait!;
    assert(wait);
    assertEquals(wait.job.input.photoIds, ["file-1"]);
    assertEquals(state.user.agentRun, null);

    await retryMediaWait(ctx);
    assertEquals(sent.length, 1);
    assertEquals(state.user.mediaWait?.until, wait.until);
    assert(state.user.mediaWait!.id !== wait.id);

    down.value = false;
    await retryMediaWait(ctx);
    assertEquals(state.user.mediaWait, null);
    assertEquals(state.meals.length, 1);
    assertEquals(state.meals[0].photoFileIds, ["file-1"]);
    assertEquals(model.length, 1);
    assertEquals(sent.length, 2);
  },
);

Deno.test("a wait past its deadline gives up with a Retry button", async () => {
  telegramFiles([]);
  const { ctx, state, sent } = setup();
  await respond(ctx, photo());
  ctx.user = state.user = {
    ...state.user,
    mediaWait: {
      ...state.user.mediaWait!,
      until: new Date(Date.now() - 1).toISOString(),
    },
  };
  await retryMediaWait(ctx);
  assertEquals(state.user.mediaWait, null);
  assertEquals(sent.length, 2);
  assertStringIncludes(text(sent[1]), "still isn't delivering");
  assert(
    buttons(sent[1] as View)
      .flat()
      .some((d) => d.startsWith("retry:")),
  );
});

Deno.test("a new message takes the waiting photo along", async () => {
  const { model, down } = telegramFiles([
    [{ name: "reply", args: { text: "Noted." } }],
  ]);
  const { ctx, state } = setup();
  await respond(ctx, photo());
  assert(state.user.mediaWait);
  down.value = false;
  ctx.user = state.user;
  await respond(ctx, {
    ...photo(),
    message_id: 501,
    photo: undefined,
    caption: undefined,
    text: "it was 2 slices",
  } as Message);
  assertEquals(state.user.mediaWait, null);
  assertEquals(model.length, 1);
  assertStringIncludes(JSON.stringify(model[0].body), "it was 2 slices");
});
