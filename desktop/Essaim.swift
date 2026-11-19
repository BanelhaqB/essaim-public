// Essaim pour macOS : une fenêtre native autour de l'interface web de ton instance.
// Pas de projet Xcode : ./build.sh compile ce fichier avec swiftc et fabrique Essaim.app.
import AppKit
import WebKit

/// Lit une adresse saisie : « essaim.exemple.fr » devient https://essaim.exemple.fr/.
func parseHome(_ raw: String?) -> URL? {
  var text = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  if text.isEmpty { return nil }
  if !text.contains("://") { text = "https://" + text }
  guard let url = URL(string: text), url.scheme?.hasPrefix("http") == true, url.host != nil else { return nil }
  return url
}

/// Adresse d'Essaim, dans l'ordre : variable ESSAIM_URL, réglage `url`
/// (`defaults write com.essaim.desktop url http://localhost:5173`, `defaults delete … url` pour revenir),
/// adresse inscrite au build (EssaimURL dans Info.plist, voir build.sh). Aucune : l'app la demande.
func configuredHome() -> URL? {
  parseHome(ProcessInfo.processInfo.environment["ESSAIM_URL"])
    ?? parseHome(UserDefaults.standard.string(forKey: "url"))
    ?? parseHome(Bundle.main.object(forInfoDictionaryKey: "EssaimURL") as? String)
}

/// Demande l'adresse de l'instance (premier lancement, menu « Changer d'adresse… ») et la garde dans le réglage `url`.
/// nil : annulé.
func askHome(current: URL?) -> URL? {
  let alert = NSAlert()
  alert.messageText = "Adresse de ton Essaim"
  let hint = "Le domaine où ton instance est déployée, par exemple essaim.exemple.fr."
  alert.informativeText = hint
  let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
  field.placeholderString = "essaim.exemple.fr"
  field.stringValue = current?.absoluteString ?? ""
  alert.accessoryView = field
  alert.addButton(withTitle: "Ouvrir")
  alert.addButton(withTitle: "Annuler")
  alert.window.initialFirstResponder = field
  while true {
    NSApp.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { return nil }
    if let url = parseHome(field.stringValue) {
      UserDefaults.standard.set(url.absoluteString, forKey: "url")
      return url
    }
    alert.informativeText = "Adresse invalide. " + hint
  }
}

/// Fixée au lancement (applicationDidFinishLaunching), avant toute page.
var home = URL(string: "about:blank")!

/// Fond de la page avant son premier rendu (mêmes valeurs que --bg dans web/app/app.css).
let pageBackground = NSColor(name: nil) { appearance in
  appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    ? NSColor(srgbRed: 0x09 / 255, green: 0x0C / 255, blue: 0x15 / 255, alpha: 1)
    : NSColor(srgbRed: 0xF5 / 255, green: 0xF6 / 255, blue: 0xFA / 255, alpha: 1)
}

func isHome(_ url: URL?) -> Bool {
  guard let url else { return false }
  return url.host == home.host && url.port == home.port
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  var themeObservation: NSKeyValueObservation?
  var badgeTimer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = buildMenu()
    guard let url = configuredHome() ?? askHome(current: nil) else {
      NSApp.terminate(nil)
      return
    }
    home = url

    let config = WKWebViewConfiguration()
    // Magasin persistant : la session Cloudflare Access survit au redémarrage de l'app.
    config.websiteDataStore = .default()
    // Se présenter comme Safari : certains fournisseurs d'identité refusent les vues web intégrées.
    config.applicationNameForUserAgent = "Version/26.0 Safari/605.1.15"
    config.preferences.isElementFullscreenEnabled = true

    webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    webView.allowsMagnification = true
    webView.isInspectable = true
    webView.underPageBackgroundColor = pageBackground
    webView.setValue(false, forKey: "drawsBackground") // évite le flash blanc au lancement

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Essaim"
    window.minSize = NSSize(width: 420, height: 480)
    window.isReleasedWhenClosed = false // fermer la fenêtre garde l'app (et son badge) ; le Dock la rouvre
    window.tabbingMode = .disallowed
    window.titlebarAppearsTransparent = true
    window.backgroundColor = pageBackground
    window.contentView = webView
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("Essaim") // position et taille gardées d'un lancement à l'autre

    // La barre de titre prend la couleur de la page (meta theme-color, qui suit le thème choisi dans Essaim).
    themeObservation = webView.observe(\.themeColor, options: [.initial, .new]) { [weak self] view, _ in
      self?.applyThemeColor(view.themeColor)
    }

    webView.load(URLRequest(url: home))
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()

    badgeTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refreshBadge() }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { window.makeKeyAndOrderFront(nil) }
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationDidBecomeActive(_ notification: Notification) { refreshBadge() }

  // MARK: Couleur de la barre de titre

  func applyThemeColor(_ color: NSColor?) {
    guard let color = color?.usingColorSpace(.sRGB) else {
      window.backgroundColor = pageBackground
      window.appearance = nil
      return
    }
    window.backgroundColor = color
    // Texte du titre lisible : apparence sombre sur un fond sombre, et inversement.
    let luminance = 0.2126 * color.redComponent + 0.7152 * color.greenComponent + 0.0722 * color.blueComponent
    window.appearance = NSAppearance(named: luminance < 0.5 ? .darkAqua : .aqua)
  }

  // MARK: Badge du Dock

  /// Questions des agents + services en panne, lus sur /badge avec les cookies de la vue web
  /// (dont CF_Authorization) : marche aussi fenêtre fermée.
  func refreshBadge() {
    let host = home.host ?? ""
    WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
      let mine = cookies.filter { c in
        let domain = c.domain.hasPrefix(".") ? String(c.domain.dropFirst()) : c.domain
        return host == domain || host.hasSuffix("." + domain)
      }
      var request = URLRequest(url: home.appendingPathComponent("badge"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
      request.httpShouldHandleCookies = false
      HTTPCookie.requestHeaderFields(with: mine).forEach { request.setValue($1, forHTTPHeaderField: $0) }
      URLSession.shared.dataTask(with: request) { data, response, _ in
        // Session Access expirée : la réponse est la page de connexion (HTML), on garde le badge tel quel.
        guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let total = json["total"] as? Int else { return }
        DispatchQueue.main.async { NSApp.dockTile.badgeLabel = total > 0 ? String(total) : nil }
      }.resume()
    }
  }

  // MARK: Navigation

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.allow) }
    if ["mailto", "tel", "sms", "facetime"].contains(scheme) {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel)
    }
    // Un lien d'Essaim vers ailleurs (GitHub, PR…) s'ouvre dans le navigateur ; ⌘-clic aussi.
    // Les redirections et les liens des pages de connexion (Access, fournisseur d'identité) restent ici.
    let fromEssaim = isHome(webView.url)
    if action.navigationType == .linkActivated, fromEssaim,
       !isHome(url) || action.modifierFlags.contains(.command) {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  /// target="_blank" et window.open : Essaim dans la fenêtre, le reste dans le navigateur.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url {
      if isHome(url) { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
    }
    return nil
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if isHome(webView.url) { refreshBadge() }
    if let path = ProcessInfo.processInfo.environment["ESSAIM_SNAPSHOT"] { snapshot(to: path) }
  }

  /// Vérification sans droit d'enregistrement d'écran : `ESSAIM_SNAPSHOT=/tmp/x.png` fait écrire
  /// une capture de la page (et le badge sur la sortie standard) après chaque chargement.
  func snapshot(to path: String) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
      self?.webView.takeSnapshot(with: nil) { image, _ in
        guard let tiff = image?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: URL(fileURLWithPath: path))
        print("capture \(path) · \(self?.webView.url?.absoluteString ?? "") · badge \(NSApp.dockTile.badgeLabel ?? "aucun")")
        fflush(stdout)
      }
    }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    showOffline(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    showOffline(error)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

  /// Page d'erreur hors ligne, avec nouvel essai automatique.
  func showOffline(_ error: Error) {
    let e = error as NSError
    if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return } // navigation remplacée par une autre
    if e.domain == "WebKitErrorDomain" && e.code == 102 { return } // « frame load interrupted » (ex. lien externe)
    let target = (e.userInfo[NSURLErrorFailingURLErrorKey] as? URL).flatMap { isHome($0) ? $0 : nil } ?? home
    let message = e.localizedDescription.replacingOccurrences(of: "<", with: "&lt;")
    let html = """
    <!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="color-scheme" content="dark light">
    <style>
      :root { color-scheme: dark light; --bg:#090C15; --ink:#E8EAF4; --muted:#8B91A8; --accent:#A99BFF; }
      @media (prefers-color-scheme: light) { :root { --bg:#F5F6FA; --ink:#141826; --muted:#5D6378; --accent:#6B55F0; } }
      body { margin:0; height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--ink);
             font:15px/1.5 -apple-system, system-ui, sans-serif; text-align:center; }
      h1 { font-size:20px; margin:0 0 6px; } p { color:var(--muted); margin:0 0 18px; }
      button { font:inherit; padding:8px 18px; border-radius:10px; border:0; background:var(--accent); color:#0D0B1A; cursor:pointer; }
    </style></head><body><div>
      <h1>Essaim est injoignable</h1>
      <p>\(message)<br>Nouvel essai automatique dans quelques secondes.</p>
      <button onclick="location.href='\(target.absoluteString)'">Réessayer</button>
    </div><script>setTimeout(() => { location.href = '\(target.absoluteString)' }, 15000)</script></body></html>
    """
    webView.loadHTMLString(html, baseURL: nil)
  }

  // MARK: Boîtes de dialogue JavaScript (confirm() etc. ne fonctionnent pas sans elles)

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Annuler")
    alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
    let alert = NSAlert()
    alert.messageText = prompt
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
    field.stringValue = defaultText ?? ""
    alert.accessoryView = field
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Annuler")
    alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
  }

  // MARK: Menus

  @objc func goHome() { go("/") }
  @objc func goServices() { go("/services") }
  @objc func goNewAgent() { go("/agents/nouveau") }
  @objc func goSettings() { go("/reglages") }
  @objc func reload() {
    // Depuis la page hors ligne (about:blank), recharger = revenir sur Essaim.
    if webView.url == nil || webView.url?.scheme == "about" { webView.load(URLRequest(url: home)) } else { webView.reload() }
  }
  @objc func zoomIn() { webView.pageZoom = min(webView.pageZoom + 0.1, 3) }
  @objc func zoomOut() { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) }
  @objc func zoomReset() { webView.pageZoom = 1 }
  @objc func openInBrowser() { NSWorkspace.shared.open(isHome(webView.url) ? webView.url! : home) }
  @objc func copyLink() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString((isHome(webView.url) ? webView.url! : home).absoluteString, forType: .string)
  }

  @objc func changeHome() {
    guard let url = askHome(current: home) else { return }
    home = url
    go("/")
    refreshBadge()
  }

  func go(_ path: String) {
    window.makeKeyAndOrderFront(nil)
    webView.load(URLRequest(url: URL(string: path, relativeTo: home)!.absoluteURL))
  }

  func buildMenu() -> NSMenu {
    let main = NSMenu()
    func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      holder.submenu = menu
      main.addItem(holder)
      return menu
    }
    func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
      let it = NSMenuItem(title: title, action: action, keyEquivalent: key)
      it.keyEquivalentModifierMask = mods
      it.target = target
      return it
    }
    let sep = { NSMenuItem.separator() }

    _ = submenu("Essaim", [
      item("À propos d'Essaim", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      sep(),
      item("Réglages…", #selector(goSettings), ",", target: self),
      item("Changer d'adresse…", #selector(changeHome), target: self),
      sep(),
      item("Masquer Essaim", #selector(NSApplication.hide(_:)), "h"),
      item("Masquer les autres", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Tout afficher", #selector(NSApplication.unhideAllApplications(_:))),
      sep(),
      item("Quitter Essaim", #selector(NSApplication.terminate(_:)), "q"),
    ])
    _ = submenu("Fichier", [
      item("Nouvel agent", #selector(goNewAgent), "n", target: self),
      sep(),
      item("Fermer la fenêtre", #selector(NSWindow.performClose(_:)), "w"),
    ])
    // Sans ce menu, ⌘C / ⌘V / ⌘A ne marchent pas dans la vue web.
    _ = submenu("Édition", [
      item("Annuler", Selector(("undo:")), "z"),
      item("Rétablir", Selector(("redo:")), "z", [.command, .shift]),
      sep(),
      item("Couper", #selector(NSText.cut(_:)), "x"),
      item("Copier", #selector(NSText.copy(_:)), "c"),
      item("Coller", #selector(NSText.paste(_:)), "v"),
      item("Coller et adapter le style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
      item("Tout sélectionner", #selector(NSText.selectAll(_:)), "a"),
    ])
    _ = submenu("Présentation", [
      item("Recharger la page", #selector(reload), "r", target: self),
      sep(),
      item("Taille réelle", #selector(zoomReset), "0", target: self),
      item("Agrandir", #selector(zoomIn), "+", target: self),
      item("Réduire", #selector(zoomOut), "-", target: self),
      sep(),
      item("Plein écran", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    _ = submenu("Aller", [
      item("Précédent", #selector(WKWebView.goBack(_:)), "["),
      item("Suivant", #selector(WKWebView.goForward(_:)), "]"),
      sep(),
      item("L'équipe", #selector(goHome), "1", target: self),
      item("Services", #selector(goServices), "2", target: self),
      sep(),
      item("Ouvrir dans le navigateur", #selector(openInBrowser), "o", [.command, .shift], target: self),
      item("Copier le lien de la page", #selector(copyLink), "c", [.command, .shift], target: self),
    ])
    let windows = submenu("Fenêtre", [
      item("Placer dans le Dock", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Réduire/agrandir", #selector(NSWindow.performZoom(_:))),
      sep(),
      item("Tout ramener au premier plan", #selector(NSApplication.arrangeInFront(_:))),
    ])
    NSApp.windowsMenu = windows
    return main
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
