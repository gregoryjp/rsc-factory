import { StatusBar, useColorScheme } from "react-native";
import { HomeScreen } from "./src/screens/HomeScreen";

export function App() {
	const scheme = useColorScheme();
	return (
		<>
			<StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} />
			<HomeScreen />
		</>
	);
}
