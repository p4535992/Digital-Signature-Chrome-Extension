console.log("Start background");

chrome.runtime.onInstalled.addListener(function () {
  chrome.declarativeContent.onPageChanged.removeRules(undefined, function () {
    chrome.declarativeContent.onPageChanged.addRules([{
      conditions: [new chrome.declarativeContent.PageStateMatcher({
        pageUrl: {
          urlSuffix: '.pdf'
        },
      })],
      actions: [new chrome.declarativeContent.ShowPageAction()]
    }]);
  });
});

const app = 'com.unical.digitalsignature.signer';

var nativeAppPort = null;
//possible value of appCurrentState: ready, loading, complete 
var StateEnum = {
  "ready": 1,
  "loading": 2,
  "running": 3,
  "complete": 4
};
Object.freeze(StateEnum)
var appCurrentState = StateEnum.start;


var storedSignatureData = {
  signatureData: "",
  infoPDF: "",

  empty: function () {
    this.signatureData = "";
    this.infoPDF = "";
  },

  isEmpty: function () {
    if (this.signatureData == "")
      return true;
    return false;
  }
}

function openConnection() {
  nativeAppPort = chrome.runtime.connectNative(app);

  console.log(nativeAppPort);

  nativeAppPort.onMessage.addListener(function (msg) {
    console.log("RECEIVED FROM NATIVE APP:");
    console.log(msg);

    if (msg.hasOwnProperty("native_app_message") && msg.native_app_message == "end") {
      //if pades -> open signed pdf 
      if (msg.signature_type == "pades") {
        var path = "file:///" + msg.local_path_newFile;
        chrome.tabs.create({
          index: 0,
          url: path,
          active: false
        }, function () {});
      }

      storedSignatureData.empty();
      chrome.runtime.sendMessage({
        state: "end",
        localPath: msg.local_path_newFile
      }, function (response) {});

      appCurrentState = StateEnum.complete;

    } else if (msg.hasOwnProperty("native_app_message") && msg.native_app_message == "info") {

      storedSignatureData.infoPDF = {
        page: msg.page,
        fields: msg.fields
      }

      //forward fields list to popup
      chrome.runtime.sendMessage({
        state: 'info',
        page: msg.page,
        fields: msg.fields
      }, function (response) {});

      appCurrentState = StateEnum.running;
      
    } else if (msg.hasOwnProperty("native_app_message") && msg.native_app_message == "error") {
      console.log("ERROR:" + msg.error);
      //TODO: show error in UI
    }

  });

  nativeAppPort.onDisconnect.addListener(function () {
    console.log("Disconnected: " + chrome.runtime.lastError.message);
  });

  return nativeAppPort;
}

function closeConnection() {
  nativeAppPort.disconnect();
}

function downloadFile(pdfURL, data, callback) {
  appCurrentState = StateEnum.loading;
  //1) get tab url
  downloadPDF(pdfURL)

  //2) download pdf 
  function downloadPDF(pdfUrl) {
    console.log("Start download document...")
    chrome.downloads.download({
      url: pdfUrl
    }, function (downloadItemID) {
      getLocalPath(downloadItemID);
    });
  }


  //3) get download file local path
  function getLocalPath(downloadItemID) {
    console.log("GET LOCAL PATH...")
    chrome.downloads.search({
      id: downloadItemID,
      state: "complete"
    }, function (item) {
      if (item.length == 0) {
        console.log("Downloading....");
        sleep(1500).then(() => { //wait X second
          getLocalPath(downloadItemID);
        });
      } else {
        console.log(item[0].filename);
        data.filename = item[0].filename;
        if (callback)
          callback(data)
      }
    });
  }

  // sleep time expects milliseconds
  function sleep(time) {
    return new Promise((resolve) => setTimeout(resolve, time));
  }
}

function sendDataForSign(data) {
  appCurrentState = StateEnum.loading;
  console.log("Send message to native app...")
  console.log(data);
  data.action = "sign";
  nativeAppPort.postMessage(data);
};

function requestPDFInfo(data) {
  appCurrentState = StateEnum.loading;
  console.log("Send message to native app...")
  console.log(data);
  data.action = popupMessageType.info;
  nativeAppPort.postMessage(data);

  delete data.action;
  storedSignatureData.signatureData = data;
};

//create a connection with content script and add a zoomchange
function zoomListener(tabId) {
  console.log(tabId);

  chrome.tabs.onZoomChange.addListener(function (ZoomChangeInfo) {
    var contentScriptPort = chrome.tabs.connect(tabId, {
      name: "content-script",
    });

    console.log("zoom change");
    if (ZoomChangeInfo.tabId == tabId) {
      contentScriptPort.postMessage({
        action: "zoom_change",
        oldZoom: ZoomChangeInfo.oldZoomFactor,
        newZoom: ZoomChangeInfo.newZoomFactor
      });
    }

    contentScriptPort.disconnect();
  });

}

var popupMessageType = {
  wakeup: 'wakeup',
  init: 'init',
  disconnect: 'disconnect',
  download_and_sign: 'download_and_sign',
  sign: 'sign',
  download_and_getInfo: 'donwload_and_getInfo',
  info: 'info',
  zoom: 'zoom',
  resetState: "resetState"
}

//listener message Popup -> Background
chrome.runtime.onMessage.addListener(
  function (request, sender, sendResponse) {
    console.log(request);
    switch (request.action) {
      case popupMessageType.wakeup:
        console.log("Background wakeup");
        break;
      case popupMessageType.resetState:
        appCurrentState = StateEnum.start;
        break;
      case popupMessageType.init:
        openConnection();
        break;
      case popupMessageType.disconnect:
        closeConnection();
        break;

      case popupMessageType.download_and_sign:
        downloadFile(request.url, request.data, sendDataForSign);
        break;
      case popupMessageType.sign: //used for directly sign a local file
        sendDataForSign(request.data);
        break;

      case popupMessageType.download_and_getInfo: //used for directly sign a local file
        downloadFile(request.url, request.data, requestPDFInfo);
        break;
      case popupMessageType.info: //used for local file
        requestPDFInfo(request.data);
        break;

      case popupMessageType.zoom:
        zoomListener(request.tabid);
        break;

      default:
        console.log("Invalid action");
        break;
    }
    sendResponse({
      ack: "success",
      received: request.action,
    });
  });