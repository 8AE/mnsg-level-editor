import { PANEL_IDS, type PanelId } from "./workspaceModel";

export interface PopupHost {
  window: Window;
  container: HTMLElement;
  dispose(): void;
}
/** Called directly from a user's panel action; only approved about:blank windows. */
export function openPanelHost(
  opener: Window,
  id: PanelId,
  onClose: () => void,
  beforeClose: () => void = () => {},
): PopupHost | null {
  if (!PANEL_IDS.includes(id)) throw new Error("Unknown workspace panel.");
  const child = opener.open("about:blank", `mnsg-panel-${id}`);
  if (!child) return null;
  const document = child.document;
  document.title = `${id.charAt(0).toUpperCase() + id.slice(1)} · MNSG Studio`;
  // The portal inherits React providers; copy their resolved DOM theme and local CSS.
  for (const attribute of Array.from(
    opener.document.documentElement.attributes,
  ))
    if (attribute.name.startsWith("data-") || attribute.name === "lang")
      document.documentElement.setAttribute(attribute.name, attribute.value);
  const charset = document.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  document.head.appendChild(charset);
  const copyStyles = () => {
    document.head
      .querySelectorAll("[data-mnsg-style-copy]")
      .forEach((node) => node.remove());
    for (const source of opener.document.head.querySelectorAll(
      'style,link[rel="stylesheet"],meta[http-equiv="Content-Security-Policy"]',
    )) {
      if (source.tagName.toLowerCase() === "link") {
        const url = new URL(
          (source as HTMLLinkElement).href,
          opener.location.href,
        );
        if (
          url.origin !== opener.location.origin ||
          !["app:", "http:", "https:"].includes(url.protocol)
        )
          continue;
      }
      const clone = document.importNode(source, true) as HTMLElement;
      clone.setAttribute("data-mnsg-style-copy", "");
      document.head.appendChild(clone);
    }
  };
  copyStyles();
  const observer = new MutationObserver(copyStyles);
  observer.observe(opener.document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  document.body.style.margin = "0";
  const container = document.createElement("div");
  container.className = "mnsg-editor popup-workspace";
  container.dataset.panelWindow = id;
  document.body.appendChild(container);
  let active = true;
  const close = () => {
    if (!active) return;
    beforeClose();
    active = false;
    observer.disconnect();
    opener.clearInterval(poll);
    child.removeEventListener("beforeunload", reclaim);
    child.removeEventListener("pagehide", close);
    onClose();
    // Never call close again during the native unload sequence. A navigation
    // that leaves the host open is handled only after its lifecycle settles.
    opener.setTimeout(() => {
      try {
        if (
          !child.closed &&
          child.document !== document &&
          child.document.readyState === "complete"
        )
          child.close();
      } catch {
        /* Native window destruction can revoke document access. */
      }
    }, 500);
  };
  const reclaim = () => {
    if (active) beforeClose();
  };
  child.addEventListener("beforeunload", reclaim);
  child.addEventListener("pagehide", close);
  const poll = opener.setInterval(() => {
    if (child.closed) close();
  }, 300);
  child.focus();
  return {
    window: child,
    container,
    dispose() {
      // Synchronous adoption precedes native document destruction. React's
      // delegated listeners cannot survive on nodes left in a destroyed frame.
      beforeClose();
      active = false;
      observer.disconnect();
      opener.clearInterval(poll);
      child.removeEventListener("beforeunload", reclaim);
      child.removeEventListener("pagehide", close);
      if (!child.closed) child.close();
    },
  };
}
