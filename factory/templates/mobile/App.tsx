import { StatusBar } from "react-native";
import { HomeScreen } from "./src/screens/HomeScreen";

export function App() {
	return (
		<>
			<StatusBar barStyle="dark-content" />
			<HomeScreen />
		</>
	);
}
