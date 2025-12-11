"use client";

const navItems = [
  { id: "section-status", icon: "💡", label: "Поточний стан" },
  { id: "section-today", icon: "🔋", label: "Графік на сьогодні" },
  { id: "section-week", icon: "🗓️", label: "Графік на тиждень" },
  { id: "section-voltage", icon: "⚡", label: "Напруга" },
];

export function SectionNav() {
  const handleScroll = (targetId: string) => {
    const element = document.getElementById(targetId);

    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 flex justify-center md:hidden">
      <div className="flex w-full items-center justify-center gap-3 border-t border-white/30 bg-white/75 px-3 py-3 text-xl shadow-lg backdrop-blur-xl ring-1 ring-white/40 dark:border-white/10 dark:bg-zinc-900/60 dark:ring-white/10">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            title={item.label}
            onClick={() => handleScroll(item.id)}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-white/70 text-2xl text-zinc-800 shadow-sm transition hover:-translate-y-0.5 hover:scale-105 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:bg-zinc-800/70 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            <span aria-hidden="true">{item.icon}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}


