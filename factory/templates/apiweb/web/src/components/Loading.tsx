import styles from "./States.module.css";

interface LoadingProps {
	label?: string;
}

export function Loading({ label = "Cargando…" }: LoadingProps) {
	return (
		<div className={styles.state} role="status" aria-live="polite">
			<span className={styles.spinner} aria-hidden="true" />
			<span>{label}</span>
		</div>
	);
}
