"use client";
import {
  Bell,
  Check,
  ChevronRight,
  CloudOff,
  Download,
  Home,
  Leaf,
  ListTodo,
  Settings,
  ShoppingBag,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "../ui/button";

const navigation = [
  { href: "/", label: "Home", icon: Home },
  { href: "/shopping", label: "Shopping", icon: ShoppingBag },
  { href: "/work", label: "Work", icon: ListTodo },
  { href: "/finance", label: "Finance", icon: Wallet },
];
type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [online, setOnline] = useState(true);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  useEffect(() => {
    setOnline(navigator.onLine);
    const update = () => setOnline(navigator.onLine);
    const install = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    window.addEventListener("beforeinstallprompt", install);
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      window.removeEventListener("beforeinstallprompt", install);
    };
  }, []);
  const active = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);
  const area =
    navigation.find((n) => active(n.href))?.label ?? "Your household";
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link href="/" className="brand" aria-label="Heima home">
          <span className="brand-mark">
            <Leaf size={27} strokeWidth={1.7} />
          </span>
          <span>
            heima<span className="brand-dot">.</span>
          </span>
        </Link>
        <p className="sidebar-kicker">ROOM FOR EVERYDAY LIFE</p>
        <nav aria-label="Primary navigation" className="desktop-nav">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={`nav-link ${active(href) ? "active" : ""}`}
              aria-current={active(href) ? "page" : undefined}
            >
              <Icon size={21} strokeWidth={1.7} />
              <span>{label}</span>
              {active(href) && <span className="nav-active-dot" />}
            </Link>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="note-orbit" />
          <p>
            A little less to remember.
            <br />
            <strong>A little more together.</strong>
          </p>
        </div>
        <div className="sidebar-bottom">
          <Link href="/settings/notifications" className="nav-link">
            <Bell size={19} />
            Notifications
          </Link>
          <Link href="/settings/household" className="household-switch">
            <span className="avatar">
              <Home size={19} />
            </span>
            <span>
              <strong>Our household</strong>
              <small>People & settings</small>
            </span>
            <Settings size={17} />
          </Link>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Our household</span>
            <ChevronRight size={14} />
            <strong>{area}</strong>
          </div>
          <div className="topbar-actions">
            <span
              className={`connection ${online ? "" : "offline"}`}
              role="status"
            >
              {online ? <Check size={13} /> : <CloudOff size={15} />}
              {online ? "Online" : "Offline"}
            </span>
            {prompt && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Install Heima"
                onClick={async () => {
                  await prompt.prompt();
                  await prompt.userChoice;
                  setPrompt(null);
                }}
              >
                <Download size={19} />
              </Button>
            )}
            <Link
              className="icon-link"
              href="/settings/notifications"
              aria-label="Notification settings"
            >
              <Bell size={20} />
            </Link>
            <Link
              className="avatar top-avatar"
              href="/settings/household"
              aria-label="Household settings"
            >
              <Home size={18} />
            </Link>
          </div>
        </header>
        <main id="main-content" className="page-content" tabIndex={-1}>
          {children}
        </main>
        <footer className="app-footer">
          <Leaf size={13} />A home for the everyday.
        </footer>
      </div>
      <nav aria-label="Mobile primary navigation" className="mobile-nav">
        {navigation.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={active(href) ? "active" : ""}
            aria-current={active(href) ? "page" : undefined}
          >
            <Icon size={21} strokeWidth={active(href) ? 2 : 1.6} />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
