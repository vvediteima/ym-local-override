from __future__ import annotations

import argparse
import asyncio
import json
from typing import Any

from playwright.async_api import Browser, Page, async_playwright


CDP_URL = "http://127.0.0.1:9777"


SNAPSHOT_JS = """
() => new Promise((resolve) => {
  const requestId = `snap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const handler = (event) => {
    const data = event.data;
    if (!data || data.source !== "ym-local-override-test" || data.type !== "snapshot-response" || data.requestId !== requestId) {
      return;
    }
    window.removeEventListener("message", handler);
    resolve(data.payload);
  };
  window.addEventListener("message", handler);
  window.postMessage({ source: "ym-local-override-test", type: "snapshot-request", requestId }, "*");
})
"""


INSTALL_BRIDGE_LOGGER_JS = """
() => {
  window.__tmpYmloMsgs = [];
  if (window.__tmpYmloLoggerInstalled) {
    return;
  }
  window.__tmpYmloLoggerInstalled = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (!data || data.source !== "ym-local-override-bridge") {
      return;
    }
    window.__tmpYmloMsgs.push({
      type: data.type || null,
      trackId: data.trackId || null,
      trackIds: Array.isArray(data.trackIds) ? data.trackIds.slice() : null,
      muted: data.muted ?? null,
      ok: data.ok ?? null,
      t: Date.now(),
    });
    if (window.__tmpYmloMsgs.length > 200) {
      window.__tmpYmloMsgs.shift();
    }
  });
}
"""


STATE_JS = """
() => ({
  pageDebug: window.__ymloPageDebug ? window.__ymloPageDebug() : null,
  location: {
    href: location.href,
    pathname: location.pathname,
    title: document.title,
  },
  mediaSession: navigator.mediaSession ? {
    playbackState: navigator.mediaSession.playbackState,
    metadata: navigator.mediaSession.metadata ? {
      title: navigator.mediaSession.metadata.title,
      artist: navigator.mediaSession.metadata.artist,
      album: navigator.mediaSession.metadata.album,
    } : null,
  } : null,
  media: Array.from(document.querySelectorAll("audio, video")).map((media) => ({
    id: media.id || null,
    src: media.currentSrc || media.src || null,
    paused: media.paused,
    ended: media.ended,
    currentTime: Number(media.currentTime || 0),
    duration: Number.isFinite(media.duration) ? Number(media.duration) : null,
    volume: Number(media.volume),
    muted: media.muted,
  })),
  sliders: Array.from(document.querySelectorAll('input[type="range"]')).map((input) => ({
    aria: input.getAttribute("aria-label") || "",
    value: input.value,
    max: input.max,
  })),
  timecodes: Array.from(document.querySelectorAll('[class*="Timecode"], [class*="timecode"]')).map((node) => ({
    text: (node.textContent || "").replace(/\\s+/g, " ").trim(),
    aria: node.getAttribute("aria-label") || "",
  })).filter((item) => item.text || item.aria),
  footerButtons: Array.from(document.querySelectorAll('footer button, [class*="PlayerBar"] button, [class*="playerBar"] button, [class*="BarDesktopPlayer"] button')).map((button) => ({
    aria: button.getAttribute("aria-label") || "",
    text: (button.textContent || "").trim(),
    visible: (() => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })(),
  })).filter((item) => item.visible),
  bridgeMsgs: (window.__tmpYmloMsgs || []).slice(-50),
})
"""


async def get_music_page(browser: Browser) -> Page:
    for context in browser.contexts:
        for page in context.pages:
            if page.url.startswith("https://music.yandex.ru/"):
                return page
    raise RuntimeError("Music page not found on the connected browser.")


async def click_header_play(page: Page) -> None:
    coords = await page.evaluate(
        """
() => {
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

  const headerButton = buttons.find((button) => {
    const aria = String(button.getAttribute('aria-label') || '').toLowerCase();
    const text = String(button.textContent || '').toLowerCase();
    const cls = String(button.className || '');
    const rect = button.getBoundingClientRect();
    const inHeader = rect.top < Math.max(280, window.innerHeight * 0.45);
    const looksLikePlay =
      aria.includes('воспроиз') ||
      aria.includes('play') ||
      text.includes('слушать') ||
      cls.includes('playControl');
    return inHeader && looksLikePlay;
  });

  if (!headerButton) {
    return null;
  }

  const rect = headerButton.getBoundingClientRect();
  return {
    x: rect.left + (rect.width / 2),
    y: rect.top + (rect.height / 2),
  };
}
""",
    )
    if not coords:
        raise RuntimeError("Header play control was not found.")
    await page.mouse.click(coords["x"], coords["y"])


async def click_row_play(page: Page) -> None:
    coords = await page.evaluate(
        """
({ trackUrl }) => {
  const match = String(trackUrl || "").match(/\\/track\\/(\\d+)/);
  const trackId = match ? match[1] : "";
  const anchors = Array.from(document.querySelectorAll(`a[href*="/track/${trackId}"]`));
  for (const anchor of anchors) {
    const container = anchor.closest('[class*="CommonTrack_root"], li, article, [role="row"]');
    if (!container) continue;
    const button = Array.from(container.querySelectorAll('button')).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (button) {
      const rect = button.getBoundingClientRect();
      return {
        x: rect.left + (rect.width / 2),
        y: rect.top + (rect.height / 2),
      };
    }
  }
  return null;
}
""",
        {"trackUrl": page.url},
    )
    if not coords:
        raise RuntimeError("Track row play button was not found.")
    await page.mouse.click(coords["x"], coords["y"])


async def click_player_bar_control(page: Page, kind: str) -> None:
    coords = await page.evaluate(
        """
({ kind }) => {
  const buttons = Array.from(document.querySelectorAll('footer button, [class*="PlayerBar"] button, [class*="playerBar"] button, [class*="BarDesktopPlayer"] button'))
    .filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

  const patterns = {
    playpause: [/пауза/i, /воспроизвед/i, /pause/i, /play/i],
    next: [/следующ/i, /next/i],
    prev: [/предыдущ/i, /previous/i, /prev/i],
  };

  const matcher = patterns[kind] || [];
  const button = buttons.find((candidate) => {
    const aria = String(candidate.getAttribute("aria-label") || "");
    return matcher.some((pattern) => pattern.test(aria));
  });

  if (!button) {
    return null;
  }

  return {
    x: button.getBoundingClientRect().left + (button.getBoundingClientRect().width / 2),
    y: button.getBoundingClientRect().top + (button.getBoundingClientRect().height / 2),
  };
}
""",
        {"kind": kind},
    )
    if not coords:
        raise RuntimeError(f"Player bar control '{kind}' was not found.")
    await page.mouse.click(coords["x"], coords["y"])


async def ensure_not_playing(page: Page) -> None:
    for _ in range(3):
        playback_state = await page.evaluate(
            "() => navigator.mediaSession ? navigator.mediaSession.playbackState : 'none'"
        )
        if playback_state != "playing":
            return

        coords = await page.evaluate(
            """
() => {
  const buttons = Array.from(document.querySelectorAll('footer button, [class*="PlayerBar"] button, [class*="playerBar"] button, [class*="BarDesktopPlayer"] button'))
    .filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  const pauseButton = buttons.find((candidate) => {
    const aria = String(candidate.getAttribute("aria-label") || "");
    return /РїР°СѓР·Р°|pause/i.test(aria);
  });
  if (!pauseButton) {
    return null;
  }
  const rect = pauseButton.getBoundingClientRect();
  return {
    x: rect.left + (rect.width / 2),
    y: rect.top + (rect.height / 2),
  };
}
""",
        )
        if not coords:
            return
        await page.mouse.click(coords["x"], coords["y"])
        await page.wait_for_timeout(1000)


async def seek_to(page: Page, seconds: float) -> None:
    coords = await page.evaluate(
        """
({ seconds }) => {
  const slider = Array.from(document.querySelectorAll('input[type="range"]')).find((input) => {
    const aria = String(input.getAttribute("aria-label") || "").toLowerCase();
    return aria.includes("time") || aria.includes("тайм") || Number(input.max) > 1;
  });
  if (!slider) {
    throw new Error("Time slider not found.");
  }
  const clamped = Math.max(0, Math.min(Number(slider.max || 0), Number(seconds || 0)));
  const rect = slider.getBoundingClientRect();
  const max = Number(slider.max || 0) || 1;
  const ratio = Math.max(0, Math.min(1, clamped / max));
  return {
    x: rect.left + (rect.width * ratio),
    y: rect.top + (rect.height / 2),
  };
}
""",
        {"seconds": seconds},
    )
    await page.mouse.click(coords["x"], coords["y"])


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--track-url", required=True)
    parser.add_argument("--actions", default="none")
    parser.add_argument("--seek-seconds", type=float, default=10.0)
    parser.add_argument("--wait-ms", type=int, default=4000)
    args = parser.parse_args()

    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp(CDP_URL)
        try:
            page = await get_music_page(browser)
            await page.bring_to_front()
            await ensure_not_playing(page)
            try:
                await page.goto(args.track_url, wait_until="domcontentloaded")
            except Exception as error:
                if "net::ERR_ABORTED" not in str(error):
                    raise
            await page.wait_for_timeout(5000)
            await ensure_not_playing(page)
            await page.evaluate(INSTALL_BRIDGE_LOGGER_JS)

            for action in [item.strip() for item in args.actions.split(",") if item.strip()]:
                if action == "none":
                    continue
                if action == "header-play":
                    await click_header_play(page)
                elif action == "row-play":
                    await click_row_play(page)
                elif action == "playpause":
                    await click_player_bar_control(page, "playpause")
                elif action == "next":
                    await click_player_bar_control(page, "next")
                elif action == "prev":
                    await click_player_bar_control(page, "prev")
                elif action == "seek":
                    await seek_to(page, args.seek_seconds)
                else:
                    raise RuntimeError(f"Unsupported action: {action}")
                await page.wait_for_timeout(args.wait_ms)

            payload: dict[str, Any] = {
                "state": await page.evaluate(STATE_JS),
                "snapshot": await page.evaluate(SNAPSHOT_JS),
            }
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
