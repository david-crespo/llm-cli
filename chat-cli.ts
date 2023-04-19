#! /usr/bin/env -S deno run --allow-env --allow-read --allow-net
import { load } from "https://deno.land/std@0.182.0/dotenv/mod.ts";
import {
  join,
  fromFileUrl,
  dirname,
} from "https://deno.land/std@0.182.0/path/mod.ts";
import {
  ChatCompletionRequestMessage,
  Configuration,
  OpenAIApi,
} from "npm:openai";
// import { pipeInput } from "./utils/io.ts";

const env = await load({
  envPath: join(dirname(fromFileUrl(import.meta.url)), ".env"),
});

console.log(env);
Deno.exit();

// const configuration = new Configuration({
//   apiKey: env.OPENAI_API_KEY,
// });
// const openai = new OpenAIApi(configuration);

// const message = {
//   role: "system",
//   content: "",
// } satisfies ChatCompletionRequestMessage;

// const lines = [];

// for await (const line of pipeInput) {
//   lines.push(line);
// }
// message.content = lines.join("\n");

// const response = await openai.createChatCompletion({
//   model: "gpt-3.5-turbo",
//   messages: [
//     {
//       role: "system",
//       content:
//         "You are a personal AI assistant. Your responses should be in markdown format.",
//     },
//     message,
//   ],
// });

// console.log(response.data.choices[0].message?.content);
