"use strict";

/* theme.js — applies the user's saved console theme before first paint, so an explicit light/dark
   choice never flashes the wrong theme on load. Load it SYNCHRONOUSLY in <head> (before the page
   renders), ahead of the page's other scripts.

   The preference is cached in localStorage under `smplmark.theme` (values: "light" | "dark" |
   "system"); shell.js keeps that cache in sync with the server (GET /api/v1/users/current/settings).
   "system" (or an unset/invalid value) removes the override, letting the CSS `prefers-color-scheme`
   media queries follow the OS. The console-profile page lets the user change it. */

(function () {
  var KEY = "smplmark.theme";
  try {
    var t = localStorage.getItem(KEY);
    if (t === "light" || t === "dark") {
      document.documentElement.setAttribute("data-theme", t);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  } catch (_e) {
    /* private mode / storage disabled — fall back to the OS default. */
  }
})();
