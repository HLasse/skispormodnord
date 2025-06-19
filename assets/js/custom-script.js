// Make externanl links open in a new tab
document.addEventListener("DOMContentLoaded", function() {
  document.querySelectorAll('a[href]').forEach(function(link) {
    // Only process if it's an external link
    try {
      const linkUrl = new URL(link.href, window.location.origin);
      if (
        linkUrl.hostname !== window.location.hostname &&
        !link.hasAttribute('target')
      ) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }
    } catch (e) {
      // Ignore invalid URLs (like anchors or javascript:)
    }
  });
});