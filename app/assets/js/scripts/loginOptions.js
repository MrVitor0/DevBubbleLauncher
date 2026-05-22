const loginOptionsCancelContainer = document.getElementById(
  "loginOptionCancelContainer",
);
const loginOptionMicrosoft = document.getElementById("loginOptionMicrosoft");
const loginOptionMojang = document.getElementById("loginOptionMojang");
const loginOptionOffline = document.getElementById("loginOptionOffline");
const loginOptionOfflineContainer = document.getElementById(
  "loginOptionOfflineContainer",
);
const loginOptionsCancelButton = document.getElementById(
  "loginOptionCancelButton",
);

let loginOptionsCancellable = false;

let loginOptionsViewOnLoginSuccess;
let loginOptionsViewOnLoginCancel;
let loginOptionsViewOnCancel;
let loginOptionsViewCancelHandler;

function loginOptionsCancelEnabled(val) {
  if (val) {
    $(loginOptionsCancelContainer).show();
  } else {
    $(loginOptionsCancelContainer).hide();
  }
}

if (isDev) {
  $(loginOptionOfflineContainer).show();
}

loginOptionMicrosoft.onclick = (e) => {
  switchView(getCurrentView(), VIEWS.waiting, 500, 500, () => {
    ipcRenderer.send(
      MSFT_OPCODE.OPEN_LOGIN,
      loginOptionsViewOnLoginSuccess,
      loginOptionsViewOnLoginCancel,
    );
  });
};

loginOptionMojang.onclick = (e) => {
  switchView(getCurrentView(), VIEWS.login, 500, 500, () => {
    loginViewOnSuccess = loginOptionsViewOnLoginSuccess;
    loginViewOnCancel = loginOptionsViewOnLoginCancel;
    loginCancelEnabled(true);
  });
};

loginOptionOffline.onclick = async () => {
  try {
    const value = await AuthManager.addOfflineAccount();
    updateSelectedAccount(value);
    switchView(
      getCurrentView(),
      loginOptionsViewOnLoginSuccess,
      500,
      500,
      async () => {
        if (loginOptionsViewOnLoginSuccess === VIEWS.settings) {
          await prepareSettings();
        }
      },
    );
  } catch (err) {
    setOverlayContent(
      Lang.queryJS("loginOptions.offlineLoginErrorTitle"),
      err.message,
      Lang.queryJS("login.tryAgain"),
    );
    setOverlayHandler(() => {
      toggleOverlay(false);
    });
    toggleOverlay(true);
  }
};

loginOptionsCancelButton.onclick = (e) => {
  switchView(getCurrentView(), loginOptionsViewOnCancel, 500, 500, () => {
    // Clear login values (Mojang login)
    // No cleanup needed for Microsoft.
    loginUsername.value = "";
    loginPassword.value = "";
    if (loginOptionsViewCancelHandler != null) {
      loginOptionsViewCancelHandler();
      loginOptionsViewCancelHandler = null;
    }
  });
};
