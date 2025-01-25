function create_role_html(role, white_text, other_text, other_text_greenChars) {
  const roleHtml = `<span class="role">${role}:</span> `;
  let whiteHtml = "";
  if (white_text !== "")
    whiteHtml = `<span class="white">${white_text}</span>`;
  let other_textHtml = "";
  if (other_text !== ""){
    let greenText = ""
    let grayText = ""
    if (other_text.substring(0, other_text_greenChars) != "")
      greenText = `<span class="green">${other_text.substring(0, other_text_greenChars)}</span>`;
    if (other_text.substring(other_text_greenChars))
      grayText = `<span class="gray">${other_text.substring(other_text_greenChars)}</span>`;
    other_textHtml = greenText + grayText;
    if (white_text !== "")
      other_textHtml = " " + other_textHtml;
  }
  return roleHtml + whiteHtml + other_textHtml;
}

function update_info(text){
  var element = document.getElementById("extra_info");
  if (element) {
    element.innerHTML = text;
  }
}

function create_cowsay_html(text, color) {
  const topLine = " " + "_".repeat(text.length + 2);
  const bottomLine = " " + "-".repeat(text.length + 2);
  const messageLine = `< ${text} >`;
  const cowDrawing = `

    \\   ^__^
     \\  (oo)\\_______
        (__)\\       )\\/\\
            ||----w |
            ||     ||

`;
  return `<span class="${color}">${topLine}\n${messageLine}\n${bottomLine}${cowDrawing}</span>`;
}

function update_or_create_message(id, html, class_name="") {
    // Check if an element with the given id exists
    var element = document.getElementById("message-" + id);

    // If the element exists, update its HTML
    if (element) {
        element.innerHTML = html;
    } else {
        // If the element does not exist, create it
        var newElement = document.createElement("pre");
        newElement.id = "message-" + id;
        newElement.innerHTML = html;
        if (class_name != "")
          newElement.className = class_name;
        
        // Append the new element to the "conversation" div
        var conversationDiv = document.getElementById("conversation-inner");
        if (conversationDiv) {
            conversationDiv.appendChild(newElement);
        } else {
            console.error('The "conversation" div does not exist.');
        }
    }
    const scrollBox = document.getElementById('scrollable-conversation');
    // Check if the scrollBox element exists to avoid errors
    if (scrollBox) {
      scrollBox.scrollTop = scrollBox.scrollHeight;
    }
}

function update_status(new_status) {
  if (new_status != "")
    new_status = " " + new_status + " ";
  var element = document.getElementById("status-text");
  if (element) {
    let full_status_length = 74;
    let paddingLength = full_status_length - new_status.length;
    element.innerHTML = `${'─'.repeat(paddingLength)}${new_status}`;
  }
}