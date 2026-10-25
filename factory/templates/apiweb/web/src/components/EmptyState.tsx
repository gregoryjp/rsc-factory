import type { ReactNode } from "react";
import styles from "./States.module.css";

interface EmptyStateProps {
	title: string;
	description?: string;
	action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
	return (
		<section className={styles.state} aria-labelledby="empty-state-title">
			<h2 id="empty-state-title" className={styles.title}>
				{title}
			</h2>
			{description === undefined ? null : <p className={styles.description}>{description}</p>}
			{action}
		</section>
	);
}
