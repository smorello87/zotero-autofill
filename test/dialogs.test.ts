import { assert } from "chai";
import { config } from "../package.json";

describe("review dialog documents", function () {
  for (const [file, required] of [
    ["enrichmentReview.xhtml", ["review-rows", "review-status"]],
    [
      "importDialog.xhtml",
      ["bibliography-input", "review-items", "destination", "import-button"],
    ],
  ] as const) {
    it(`loads ${file} with accessible review controls`, async function () {
      let win: Window | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Dialog failed to load")),
            3000,
          );
          Zotero.getMainWindow().openDialog(
            `chrome://${config.addonRef}/content/${file}`,
            "",
            "chrome,dialog",
            {
              onLoad(window: Window) {
                win = window;
                clearTimeout(timer);
                try {
                  for (const id of required)
                    assert.exists(window.document.getElementById(id));
                  assert.exists(
                    window.document.querySelector('[aria-live="polite"]'),
                  );
                  resolve();
                } catch (error) {
                  reject(error);
                }
              },
            },
          );
        });
      } finally {
        win?.close();
      }
    });
  }
});
