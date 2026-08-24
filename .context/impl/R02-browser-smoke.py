import os
from pathlib import Path
from urllib.parse import quote

from playwright.sync_api import sync_playwright


BASE = "http://127.0.0.1:8088"
SLUG = "201011929-이미지를-16x16-단어로-읽는다고-비전-트랜스포머vit-이야기"
POST = f"{BASE}/p/{quote(SLUG)}.html"
ARTIFACTS = Path(__file__).resolve().parent


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    browser_errors: list[str] = []
    page.on("pageerror", lambda error: browser_errors.append(f"page: {error}"))
    page.on(
        "console",
        lambda message: browser_errors.append(f"console: {message.text}")
        if message.type == "error"
        else None,
    )

    response = page.goto(BASE + "/", wait_until="networkidle")
    assert response and response.status == 200
    assert page.locator(".card").count() == 5
    search = page.locator("#post-search")
    search.fill("비전")
    page.wait_for_timeout(180)
    assert page.locator(".card:visible").count() == 1
    assert "1개" in page.locator("#search-status").inner_text()
    search.press("Escape")
    assert page.locator(".card:visible").count() == 5

    theme = page.locator("#theme-toggle")
    before_theme = page.locator("html").get_attribute("data-theme")
    theme.click()
    after_theme = page.locator("html").get_attribute("data-theme")
    assert before_theme != after_theme
    assert theme.get_attribute("aria-pressed") in ("true", "false")

    response = page.goto(POST, wait_until="networkidle")
    assert response and response.status == 200
    page.wait_for_selector(".mermaid[data-processed='true'] svg", timeout=15_000)
    assert page.locator(".mermaid[data-processed='true'] svg").count() >= 1

    annotation = page.locator(".annot").first
    annotation.focus()
    annotation.press("Enter")
    assert annotation.get_attribute("aria-expanded") == "true"
    page.keyboard.press("Escape")
    assert annotation.get_attribute("aria-expanded") == "false"

    chat_toggle = page.locator("#chat-toggle")
    chat_toggle.click()
    assert chat_toggle.get_attribute("aria-expanded") == "true"
    assert page.locator("#chat-input").evaluate("element => document.activeElement === element")
    page.keyboard.press("Escape")
    assert chat_toggle.get_attribute("aria-expanded") == "false"
    page.screenshot(path=str(ARTIFACTS / "R02-browser-desktop.png"), full_page=True)

    mobile = browser.new_page(viewport={"width": 390, "height": 844})
    mobile_errors: list[str] = []
    mobile.on("pageerror", lambda error: mobile_errors.append(f"page: {error}"))
    mobile.on(
        "console",
        lambda message: mobile_errors.append(f"console: {message.text}")
        if message.type == "error"
        else None,
    )
    mobile_response = mobile.goto(POST, wait_until="networkidle")
    assert mobile_response and mobile_response.status == 200
    mobile.wait_for_selector(".mermaid[data-processed='true'] svg", timeout=15_000)
    sizes = mobile.evaluate(
        "({scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth})"
    )
    assert sizes["scroll"] == sizes["client"], sizes
    mobile.screenshot(path=str(ARTIFACTS / "R02-browser-mobile.png"), full_page=True)
    assert not mobile_errors, mobile_errors

    missing = mobile.goto(BASE + "/deep/missing/page", wait_until="networkidle")
    assert missing and missing.status == 404
    assert mobile.locator("link[href='/static/style.css']").count() == 1
    assert mobile.evaluate("getComputedStyle(document.body).fontFamily.includes('Pretendard')")

    math_base = os.environ.get("ARXIBLOG_MATH_SMOKE_BASE")
    if math_base:
        math = browser.new_page(viewport={"width": 900, "height": 700})
        math_errors: list[str] = []
        math.on("pageerror", lambda error: math_errors.append(f"page: {error}"))
        math.on(
            "console",
            lambda message: math_errors.append(f"console: {message.text}")
            if message.type == "error"
            else None,
        )
        math_response = math.goto(math_base + "/p/math.html", wait_until="networkidle")
        assert math_response and math_response.status == 200
        math.wait_for_selector(".katex", timeout=10_000)
        assert math.locator(".katex").count() >= 2
        assert not math_errors, math_errors

    assert not browser_errors, browser_errors
    browser.close()

print("browser smoke: index/search/theme/annotation/chat/Mermaid/mobile/404 ok")
