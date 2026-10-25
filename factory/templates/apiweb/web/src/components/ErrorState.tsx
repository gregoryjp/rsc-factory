import { t } from "../i18n/t";
import styles from "./States.module.css";

interface ErrorStateProps {
	message: string;
	onRetry?: () => void;
	retryLabel?: string;
}

export function ErrorState({ message, onRetry, retryLabel = t("state.retry") }: ErrorStateProps) {
	return (
		<div className={styles.state} role="alert">
			<p className={styles.title}>{message}</p>
			{onRetry === undefined ? null : (
				<button type="button" className={styles.button} onClick={onRetry}>
					{retryLabel}
				</button>
			)}
		</div>
	);
}
