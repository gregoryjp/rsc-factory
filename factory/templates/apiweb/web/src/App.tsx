import styles from "./App.module.css";
import { PRODUCT_NAME } from "./config/product";

const LEGAL_LINKS = [
	{ href: "/legal/aviso-legal.html", label: "Aviso legal" },
	{ href: "/legal/politica-privacidad.html", label: "Política de privacidad" },
	{ href: "/legal/politica-cookies.html", label: "Política de cookies" },
] as const;

export function App() {
	return (
		<>
			<a className="skip-link" href="#main">
				Saltar al contenido
			</a>
			<main id="main" className={styles.app}>
				<h1 className={styles.title}>{PRODUCT_NAME}</h1>
				<p className={styles.subtitle}>Base lista para construir.</p>
			</main>
			<footer className="site-footer">
				<nav className="site-footer__nav" aria-label="Información legal">
					{LEGAL_LINKS.map((link) => (
						<a key={link.href} href={link.href}>
							{link.label}
						</a>
					))}
				</nav>
			</footer>
		</>
	);
}
