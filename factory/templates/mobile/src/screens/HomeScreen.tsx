import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { formatGreeting } from "../domain/greeting";
import { fontSize, minTouchTarget, radius, spacing } from "../theme/tokens";
import { useColors } from "../theme/useColors";

export function HomeScreen() {
	const [greeting, setGreeting] = useState("");
	const colors = useColors();
	const styles = useMemo(
		() =>
			StyleSheet.create({
				container: {
					flex: 1,
					alignItems: "center",
					justifyContent: "center",
					gap: spacing.md,
					padding: spacing.lg,
					backgroundColor: colors.background,
				},
				title: { fontSize: fontSize.title, fontWeight: "700", color: colors.text },
				body: { fontSize: fontSize.body, color: colors.text },
				button: {
					minHeight: minTouchTarget,
					justifyContent: "center",
					paddingHorizontal: spacing.lg,
					borderRadius: radius.md,
					backgroundColor: colors.primary,
				},
				buttonText: { fontSize: fontSize.body, fontWeight: "600", color: colors.onPrimary },
			}),
		[colors],
	);

	return (
		<View style={styles.container}>
			<Text accessibilityRole="header" style={styles.title}>
				{{PRODUCT_NAME}}
			</Text>
			{greeting === "" ? null : <Text style={styles.body}>{greeting}</Text>}
			<Pressable
				accessibilityRole="button"
				accessibilityLabel="Comenzar"
				onPress={() => setGreeting(formatGreeting("equipo"))}
				style={styles.button}
			>
				<Text style={styles.buttonText}>Comenzar</Text>
			</Pressable>
		</View>
	);
}
