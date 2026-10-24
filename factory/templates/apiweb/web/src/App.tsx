import styles from "./App.module.css";
import { PRODUCT_NAME } from "./config/product";

export function App() {
	return (
		<main className={styles.app}>
			<h1 className={styles.title}>{PRODUCT_NAME}</h1>
			<p className={styles.subtitle}>Base lista para construir.</p>
		</main>
	);
}
