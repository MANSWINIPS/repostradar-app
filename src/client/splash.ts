import { context, requestExpandedMode } from "@devvit/web/client";

const titleElement = document.getElementById("title") as HTMLHeadingElement;
const subtitleElement = document.getElementById(
  "subtitle",
) as HTMLParagraphElement;
const startButton = document.getElementById(
  "start-button",
) as HTMLButtonElement;

startButton.addEventListener("click", (e) => {
  requestExpandedMode(e, "game");
});

function init() {
  const sub = context.subredditName ?? "this community";
  titleElement.textContent = "🛰️ RepostRadar";
  subtitleElement.textContent = `One-tap duplicate detection for r/${sub}`;
}

init();
