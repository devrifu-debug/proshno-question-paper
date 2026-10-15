/* ============================================================
   Bubblemark settings — edit this file, then re-upload the folder.
   ============================================================

   USAGE STATISTICS (optional). Leave everything empty to send nothing.
   Fill in ONE or more of these to see what people do in the app.
   Events never include photos, student names or roll numbers.

   webhook : a web address that receives events as JSON.
             Easiest: a Google Sheet + Apps Script (see SETUP-GUIDE.txt).
   ga4     : Google Analytics 4 measurement ID, e.g. 'G-ABC123XYZ'.
   umami   : Umami website ID (https://umami.is), e.g. { websiteId: 'xxxx-...' }.
*/
window.BUBBLEMARK_CONFIG = {
  analytics: {
    webhook: '',
    ga4: '',
    umami: { websiteId: 'e979e22a-7028-41c8-b691-0a0f9be653c4', src: 'https://stats.diversekit.cloud/script.js' }
  }
};
