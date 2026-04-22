// Open a PDF blob in a hidden iframe and trigger the browser's native print
// dialog immediately. Used everywhere we generate a label / picking slip /
// packing slip so the user sees the print dialog straight away instead of
// having to open a downloaded file first.
//
// Notes:
// - We use a hidden <iframe> rather than window.open() because most modern
//   browsers block popups triggered after an async fetch, but allow a same-
//   origin iframe to call print() once it has loaded.
// - The blob URL and iframe are revoked/removed after the print dialog
//   closes (or after a long timeout, in case the browser never fires
//   afterprint — Safari is unreliable here).
// - If the browser blocks the print dialog for any reason we fall back to
//   downloading the file so the user is never left with nothing.

export async function printPdfBlob(blob: Blob, fallbackFilename: string): Promise<void> {
  if (blob.type && blob.type !== "application/pdf") {
    throw new Error("Server did not return a PDF");
  }

  const url = URL.createObjectURL(blob);

  const cleanup = (iframe: HTMLIFrameElement) => {
    try { iframe.remove(); } catch { /* noop */ }
    try { URL.revokeObjectURL(url); } catch { /* noop */ }
  };

  const downloadFallback = () => {
    const a = document.createElement("a");
    a.href = url;
    a.download = fallbackFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser a moment to start the download before revoking.
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* noop */ } }, 10_000);
  };

  return new Promise<void>((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.style.visibility = "hidden";
    iframe.setAttribute("aria-hidden", "true");
    iframe.src = url;

    let printed = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup(iframe);
      resolve();
    };

    iframe.onload = () => {
      // Some browsers fire onload before the embedded PDF viewer is ready.
      // A small delay gives Chrome/Edge time to mount the PDF plugin.
      setTimeout(() => {
        try {
          const win = iframe.contentWindow;
          if (!win) throw new Error("no iframe window");
          win.focus();
          win.print();
          printed = true;
          // afterprint fires when the user closes/cancels the dialog.
          win.addEventListener("afterprint", finish, { once: true });
          // Safety net: if afterprint never fires (Safari, or the user
          // navigates away), revoke the blob after 10 minutes.
          setTimeout(finish, 10 * 60_000);
        } catch {
          // Browser blocked print or PDF viewer not available — fall back
          // to a normal download so the user still gets their file.
          if (!printed) downloadFallback();
          finish();
        }
      }, 250);
    };

    iframe.onerror = () => {
      downloadFallback();
      finish();
    };

    document.body.appendChild(iframe);
  });
}
