import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { formatGreeting } from "../domain/greeting";
import { colors, fontSize, radius, spacing } from "../theme/tokens";

export function HomeScreen() {
	const [greeting, setGreeting] = useState("");

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

const styles = StyleSheet.create({
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
		minHeight: 48,
		justifyContent: "center",
		paddingHorizontal: spacing.lg,
		borderRadius: radius.md,
		backgroundColor: colors.primary,
	},
	buttonText: { fontSize: fontSize.body, fontWeight: "600", color: colors.onPrimary },
});
