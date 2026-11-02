// Claude 데스크톱 앱 창의 글자를 손쉬운 사용(Accessibility) 통로로 읽어 JSON 으로 내보낸다.
// 사용: ax-read [--prompt] [앱 이름]   (기본 "Claude")
// 출력: {"ok":true,"app":"Claude","nodes":[{"d":깊이,"r":"역할","c":"DOM class","t":"글자"}…]}
//       {"ok":false,"error":"not-trusted"|"no-app"|"no-window"}
// Claude 앱(Electron/Chromium)은 AXManualAccessibility 를 켜야 웹 내용을 내보낸다.
import Cocoa
import ApplicationServices

func out(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj, options: []), let s = String(data: data, encoding: .utf8) { print(s) }
  exit(0)
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
  return v
}

let args = Array(CommandLine.arguments.dropFirst())
let prompt = args.contains("--prompt")
let appName = args.first(where: { !$0.hasPrefix("--") }) ?? "Claude"

let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
if !AXIsProcessTrustedWithOptions(opts) { out(["ok": false, "error": "not-trusted"]) }

// Claude 데스크톱 앱만 (번들 ID 우선, 이름은 정확히 "Claude" 인 일반 앱만). Finder 등 다른 앱은 절대 안 읽음
let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.processIdentifier != getpid() }
let target = running.first(where: { $0.bundleIdentifier == "com.anthropic.claudefordesktop" })
  ?? running.first(where: { $0.localizedName == appName && ($0.bundleIdentifier ?? "").lowercased().contains("anthropic") })
guard let target = target else { out(["ok": false, "error": "no-app"]) ; exit(0) }

let appEl = AXUIElementCreateApplication(target.processIdentifier)
// Chromium 에 "보조 기술이 있다"고 알려 웹 내용의 접근성 트리를 만들게 한다 (처음엔 조금 걸림)
let already = (attr(appEl, "AXManualAccessibility") as? Bool) ?? false
AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
if !already { Thread.sleep(forTimeInterval: 0.8) }

// 가장 큰 창 (대화 창). 메뉴 막대 같은 작은 창은 건너뜀
func area(_ w: AXUIElement) -> Double {
  var size = CGSize.zero
  if let v = attr(w, kAXSizeAttribute as String) { AXValueGetValue(v as! AXValue, .cgSize, &size) }
  return Double(size.width * size.height)
}
var window: AXUIElement? = nil
if let ws = attr(appEl, kAXWindowsAttribute as String) as? [AXUIElement], !ws.isEmpty { window = ws.max(by: { area($0) < area($1) }) }
if window == nil, let w = attr(appEl, kAXFocusedWindowAttribute as String) { window = (w as! AXUIElement) }
guard let win = window else { out(["ok": false, "error": "no-window"]) ; exit(0) }

var nodes: [[String: Any]] = []
let maxNodes = 30000
func walk(_ el: AXUIElement, _ depth: Int) {
  if nodes.count >= maxNodes || depth > 120 { return }
  let role = (attr(el, kAXRoleAttribute as String) as? String) ?? ""
  var text = ""
  if role == "AXStaticText" || role == "AXHeading" || role == "AXTextArea" || role == "AXTextField" {
    text = (attr(el, kAXValueAttribute as String) as? String) ?? ""
  }
  if text.isEmpty, role == "AXStaticText" { text = (attr(el, kAXTitleAttribute as String) as? String) ?? "" }
  let cls = ((attr(el, "AXDOMClassList") as? [String]) ?? []).joined(separator: " ")
  let tid = (attr(el, "AXDOMIdentifier") as? String) ?? ""
  if !text.isEmpty || !cls.isEmpty || !tid.isEmpty {
    var n: [String: Any] = ["d": depth, "r": role]
    if !cls.isEmpty { n["c"] = cls }
    if !tid.isEmpty { n["i"] = tid }
    if !text.isEmpty { n["t"] = text }
    nodes.append(n)
  }
  if let kids = attr(el, kAXChildrenAttribute as String) as? [AXUIElement] {
    for k in kids { walk(k, depth + 1) }
  }
}
walk(win, 0)
let title = (attr(win, kAXTitleAttribute as String) as? String) ?? ""
out(["ok": true, "app": target.localizedName ?? appName, "bundle": target.bundleIdentifier ?? "", "title": title, "truncated": nodes.count >= maxNodes, "nodes": nodes])
