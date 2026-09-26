import SwiftUI

struct RootContainerView: View {
    @EnvironmentObject private var appModel: AppViewModel

    private var visibleErrorMessage: String? {
        guard let message = appModel.errorMessage?.trimmingCharacters(in: .whitespacesAndNewlines),
              !message.isEmpty else {
            return nil
        }

        let lowered = message.lowercased()
        guard !lowered.contains("cancelled"), !lowered.contains("canceled") else {
            return nil
        }

        return message
    }

    var body: some View {
        Group {
            if appModel.authUser != nil {
                RootTabView()
            } else {
                LoginView()
            }
        }
        .overlay(alignment: .top) {
            if let error = visibleErrorMessage {
                ErrorBanner(message: error) {
                    appModel.errorMessage = nil
                }
                .padding()
            }
        }
    }
}

struct ErrorBanner: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.yellow)
            Text(message)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.white)
                .multilineTextAlignment(.leading)
            Spacer()
            Button("Cerrar", action: dismiss)
                .font(.caption.bold())
                .foregroundStyle(.white)
        }
        .padding()
        .background(Color.red.opacity(0.85))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(radius: 12)
    }
}
