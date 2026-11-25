// usee's website: the one script. It loads nothing and sends nothing.

// Each section's parts rise in as they come into view; without this script, all are shown.
const motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (motion && 'IntersectionObserver' in window) {
  document.documentElement.classList.add('animate');
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          seen.unobserve(entry.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  for (const element of document.querySelectorAll('.rise, .shutter')) {
    seen.observe(element);
  }
}

// For whoever opens the developer tools on a screen recorder's website.
console.log(
  '%cusee',
  'font: 700 28px "Segoe UI Variable Display", "Segoe UI", sans-serif; color: #ffb23e',
);
console.log(
  [
    "You opened the developer tools on a screen recorder's website. Respect.",
    'No trackers to find here: the Network tab shows this site and nothing else.',
    'This page, and all of usee, is on GitHub: https://github.com/techuhat/usee',
    'Pull requests welcome. Typo fixes especially.',
  ].join('\n'),
);
