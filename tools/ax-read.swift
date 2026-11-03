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

// 창이 여러 개일 수 있음 (빠른 입력 창·숨은 창 등). 모든 창을 읽어서 글이 가장 많은 창을 고른다.
// 웹 내용 트리는 처음 켤 때 늦게 만들어지므로, 글이 거의 없으면 잠깐 기다렸다 다시 읽는다.
let maxNodes = 30000
func walk(_ el: AXUIElement, _ depth: Int, _ nodes: inout [[String: Any]]) {
  if nodes.count >= maxNodes || depth > 150 { return }
  let role = (attr(el, kAXRoleAttribute as String) as? String) ?? ""
  var text = ""
  if role == "AXStaticText" || role == "AXHeading" || role == "AXTextArea" || role == "AXTextField" {
    text = (attr(el, kAXValueAttribute as String) as? String) ?? ""
  }
  if text.isEmpty, role == "AXStaticText" { text = (attr(el, kAXTitleAttribute as String) as? String) ?? "" }
  if text.isEmpty, role == "AXStaticText" { text = (attr(el, kAXDescriptionAttribute as String) as? String) ?? "" }
  let cls = ((attr(el, "AXDOMClassList") as? [String]) ?? []).joined(separator: " ")
  let tid = (attr(el, "AXDOMIdentifier") as? String) ?? ""
  if !text.isEmpty || !cls.isEmpty || !tid.isEmpty || role == "AXWebArea" {
    var n: [String: Any] = ["d": depth, "r": role]
    if !cls.isEmpty { n["c"] = cls }
    if !tid.isEmpty { n["i"] = tid }
    if !text.isEmpty { n["t"] = text }
    nodes.append(n)
  }
  if let kids = attr(el, kAXChildrenAttribute as String) as? [AXUIElement] {
    for k in kids { walk(k, depth + 1, &nodes) }
  }
}

func readBest() -> (nodes: [[String: Any]], title: String, windows: Int) {
  var wins = (attr(appEl, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
  if wins.isEmpty, let w = attr(appEl, kAXFocusedWindowAttribute as String) { wins = [w as! AXUIElement] }
  var best: [[String: Any]] = [], bestTitle = "", bestScore = -1
  for w in wins {
    var nodes: [[String: Any]] = []
    walk(w, 0, &nodes)
    let score = nodes.filter { $0["t"] != nil }.count
    if score > bestScore { best = nodes; bestScore = score; bestTitle = (attr(w, kAXTitleAttribute as String) as? String) ?? "" }
  }
  return (best, bestTitle, wins.count)
}

var r = readBest()
var tries = 0
while r.nodes.filter({ $0["t"] != nil }).count < 3 && tries < 3 {
  AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  Thread.sleep(forTimeInterval: 1.0)
  r = readBest(); tries += 1
}
if r.windows == 0 { out(["ok": false, "error": "no-window"]) }
out(["ok": true, "app": target.localizedName ?? appName, "bundle": target.bundleIdentifier ?? "", "title": r.title, "windows": r.windows, "retries": tries, "truncated": r.nodes.count >= maxNodes, "nodes": r.nodes])
