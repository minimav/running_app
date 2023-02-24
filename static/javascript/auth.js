window.onload = function () {
  const form = document.getElementById("login-form");
  form.onsubmit = login.bind(form);
};

const login = (event) => {
  event.preventDefault();

  const username = event.target.elements.username.value;
  const password = event.target.elements.password.value;

  authAction({ url: "/login", redirectUrl: "/", username, password });
};

const authAction = ({ url, redirectUrl, username, password }) => {
  if (username.length === 0) {
    populateAndShowModal({
      title: "Username error",
      content: "No username was supplied.",
    });
    return;
  } else if (password.length === 0) {
    populateAndShowModal({
      title: "Password error",
      content: "No password was supplied.",
    });
    return;
  } else if (password.length < 8) {
    populateAndShowModal({
      title: "Password error",
      content: "Password must have >= 8 characters.",
    });
    return;
  }

  const formData = new FormData();
  formData.append("username", username);
  formData.append("password", password);

  const payload = {
    method: "POST",
    body: formData,
  };

  fetch(url, payload)
    .then((response) => {
      if (!response.ok) {
        return Promise.reject();
      }
    })
    .then((_) => {
      window.location.href = redirectUrl;
    })
    .catch((_) => {
      populateAndShowModal({ title: "Error", content: "Login failed" });
    });
};

const register = () => {
  const username = document.getElementById("username-input").value;
  const password = document.getElementById("password-input").value;
  authAction({
    url: "/register",
    redirectUrl: "/login?register=True",
    username,
    password,
  });
};

document.addEventListener("DOMContentLoaded", function (event) {
  const params = new Proxy(new URLSearchParams(window.location.search), {
    get: (searchParams, prop) => searchParams.get(prop),
  });
  if (params.register) {
    populateAndShowModal({
      title: "Registration success",
      content: "User successfully registered, please log in.",
    });
  }
});
