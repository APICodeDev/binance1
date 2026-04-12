import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var appModel: AppViewModel
    @State private var identifier = ""
    @State private var password = ""
    @State private var token = ""
    @State private var loginMode = 0

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 10) {
                        Image(systemName: "bolt.horizontal.circle.fill")
                            .font(.system(size: 54))
                            .foregroundStyle(.yellow)
                        Text("Bitget Desk Native")
                            .font(.system(size: 32, weight: .black, design: .rounded))
                        Text("Clon nativo iOS del dashboard actual, separado del proyecto web.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 24)

                    GroupBox("Servidor API") {
                        TextField("https://trades.apicode.cloud", text: $appModel.baseURL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .padding(12)
                            .background(Color.white.opacity(0.06))
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }

                    Picker("Modo", selection: $loginMode) {
                        Text("Cuenta").tag(0)
                        Text("Token").tag(1)
                    }
                    .pickerStyle(.segmented)

                    if loginMode == 0 {
                        GroupBox("Acceso por cuenta") {
                            VStack(spacing: 12) {
                                TextField("Email o username", text: $identifier)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .padding(12)
                                    .background(Color.white.opacity(0.06))
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                                SecureField("Password", text: $password)
                                    .padding(12)
                                    .background(Color.white.opacity(0.06))
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                                Button {
                                    Task { await appModel.login(identifier: identifier, password: password) }
                                } label: {
                                    Text(appModel.isLoading ? "Entrando..." : "Entrar")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(PrimaryButtonStyle())
                                .disabled(appModel.isLoading || identifier.isEmpty || password.isEmpty)
                            }
                        }
                    } else {
                        GroupBox("Acceso por token API") {
                            VStack(spacing: 12) {
                                TextField("Pega el token", text: $token, axis: .vertical)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .padding(12)
                                    .background(Color.white.opacity(0.06))
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                                Button {
                                    Task { await appModel.loginWithToken(token) }
                                } label: {
                                    Text(appModel.isLoading ? "Validando..." : "Entrar con token")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(PrimaryButtonStyle())
                                .disabled(appModel.isLoading || token.isEmpty)
                            }
                        }
                    }
                }
                .padding()
            }
            .background(Color.black.ignoresSafeArea())
        }
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .padding()
            .background(configuration.isPressed ? Color.yellow.opacity(0.7) : Color.yellow)
            .foregroundStyle(.black)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}
