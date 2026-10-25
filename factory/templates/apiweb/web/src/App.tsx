import styles from "./App.module.css";
import { PRODUCT_NAME } from "./config/product";
import type { MessageKey } from "./i18n/messages";
import { t } from "./i18n/t";

const LEGAL_LINKS: readonly { href: string; label: MessageKey }[] = [
	{ href: "/legal/aviso-legal.html", label: "legal.notice" },
	{ href: "/legal/politica-privacidad.html", label: "legal.privacy" },
	{ href: "/legal/politica-cookies.html", label: "legal.cookies" },
];

export function App() {
	return (
		<>
			<a className="skip-link" href="#main">
				{t("app.skip")}
			</a>
			<main id="main" className={styles.app}>
				<h1 className={styles.title}>{PRODUCT_NAME}</h1>
				<p className={styles.subtitle}>{t("app.subtitle")}</p>
			</main>
			<footer className="site-footer">
				<nav className="site-footer__nav" aria-label={t("legal.nav")}>
					{LEGAL_LINKS.map((link) => (
						<a key={link.href} href={link.href}>
							{t(link.label)}
						</a>
					))}
				</nav>
			</footer>
		</>
	);
}
