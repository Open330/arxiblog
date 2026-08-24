from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:4188"
POST = BASE + "/p/%EC%96%B4%ED%85%90%EC%85%98%EC%9D%84-%EC%A7%81%EA%B4%80%EC%A0%81%EC%9C%BC%EB%A1%9C-%EC%9D%B4%ED%95%B4%ED%95%98%EA%B8%B0.html"

with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})

    response = page.goto(BASE + "/", wait_until="networkidle")
    assert response and response.status == 200
    assert page.locator(".card").count() == 2
    page.locator("#post-search").fill("이미지")
    page.wait_for_timeout(180)
    assert page.locator(".card:visible").count() == 1
    assert "1개" in page.locator("#search-status").inner_text()
    page.locator("#post-search").press("Escape")
    assert page.locator(".card:visible").count() == 2

    theme = page.locator("#theme-toggle")
    theme.click()
    assert page.locator("html").get_attribute("data-theme") in ("light", "dark")
    assert theme.get_attribute("aria-pressed") in ("true", "false")

    response = page.goto(POST, wait_until="networkidle")
    assert response and response.status == 200
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
    page.locator(".ask-chip").first.click()
    page.wait_for_function("document.querySelectorAll('.chat-msg.bot').length >= 2")
    page.wait_for_function("document.querySelector('#chat-form').getAttribute('aria-busy') === 'false'")
    assert "API 키" in page.locator(".chat-msg.bot").last.inner_text()
    page.keyboard.press("Escape")
    assert chat_toggle.get_attribute("aria-expanded") == "false"

    mobile = browser.new_page(viewport={"width": 390, "height": 844})
    mobile.goto(POST, wait_until="networkidle")
    sizes = mobile.evaluate("({scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth})")
    assert sizes["scroll"] == sizes["client"], sizes

    missing = mobile.goto(BASE + "/deep/missing/page", wait_until="networkidle")
    assert missing and missing.status == 404
    assert mobile.locator("link[href='/static/style.css']").count() == 1
    assert mobile.evaluate("getComputedStyle(document.body).fontFamily.includes('Pretendard')")

    browser.close()

print("browser smoke: ok")
