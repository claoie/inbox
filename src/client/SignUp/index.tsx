import { useState, useContext, useEffect, ChangeEvent, KeyboardEvent } from "react";
import { useMutation } from "react-query";
import { useParams, useLocation, Link } from "react-router-dom";

import SignUpIcon from "./components/SignUpIcon";
import UserEditIcon from "./components/UserEditIcon";

import { SignedUser, SignedUserType } from "common";
import { ApiResponse, SetInfoPostResponse, TokenPostResponse } from "server";
import { Context, call } from "client";

import "./index.scss";

interface SignUpBody {
  email: string;
  token?: string | null;
  username?: string;
  password?: string;
}

interface SetInfoResponse extends SetInfoPostResponse {
  username?: string;
}

const SignUp = () => {
  const { setUserInfo } = useContext(Context);

  const { email } = useParams<{ email: string }>();
  const query = new URLSearchParams(useLocation().search);
  const token = query.get("t");
  const username = query.get("u");

  const [emailInput, setEmailInput] = useState(email || "");
  const [usernameInput, setUsernameInput] = useState(username || "");
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordConfirmInput, setPasswordConfirmInput] = useState("");
  const [passwordMismatch, setPasswordMismatch] = useState(false);

  const onChangeEmail = (e: ChangeEvent<HTMLInputElement>) => {
    setEmailInput(e.target.value);
  };

  const onChangeUsername = (e: ChangeEvent<HTMLInputElement>) => {
    setUsernameInput(e.target.value);
  };

  const onChangePassword = (e: ChangeEvent<HTMLInputElement>) => {
    setPasswordInput(e.target.value);
    setPasswordMismatch(false);
  };

  const onChangePasswordConfirm = (e: ChangeEvent<HTMLInputElement>) => {
    setPasswordConfirmInput(e.target.value);
    setPasswordMismatch(false);
  };

  type DynamicResponse = SetInfoPostResponse | TokenPostResponse;
  type PromiseDynamicApiResponse = Promise<ApiResponse<DynamicResponse>>;

  const mutation = useMutation((body: SignUpBody): PromiseDynamicApiResponse => {
    if (email) {
      return call.post<SetInfoPostResponse>("/api/users/set-info", body);
    } else return call.post<TokenPostResponse>("/api/users/token", body);
  });

  let infoMessage;

  if (email) {
    infoMessage = "🤐 Please set your user information.";
    if (passwordMismatch) infoMessage = "⚠️ Passwords do not match. Please try again.";
    if (mutation.isLoading) infoMessage = "🧐 Setting your information...";
    if (mutation.isError) infoMessage = "🤯 Server error";
    if (mutation.data?.status === "success") infoMessage = "🤗 All set up!";
    else if (mutation.data) {
      infoMessage = "🤔 Something is wrong. Please try again.";
    }
  } else {
    infoMessage = "😀 Please provide your email.";
    if (mutation.isLoading) infoMessage = "🧐 Sending confirmation email...";
    if (mutation.isError) infoMessage = "🤯 Server error";
    if (mutation.data?.status === "success") {
      infoMessage =
        "🤗 Please check your mail box and continue to set your user information.";
    } else if (mutation.data) {
      infoMessage = "🤔 Something is wrong. Please try again.";
    }
  }

  useEffect(() => {
    const data = mutation.data as SetInfoResponse | undefined;
    if (data?.username && setUserInfo) {
      setTimeout(() => {
        const user = new SignedUser(data as unknown as SignedUserType);
        setUserInfo(user);
      }, 500);
    }
  }, [mutation.data, setUserInfo]);

  const onClickSignUp = () => {
    if (email && passwordInput && passwordInput !== passwordConfirmInput) {
      setPasswordMismatch(true);
      return;
    }
    setPasswordMismatch(false);
    mutation.mutate({
      email: emailInput,
      token,
      username: usernameInput,
      password: passwordInput
    });
    if (email) window.name = "mail-confirm";
  };

  const onKeyDownInput = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") onClickSignUp();
  };

  return (
    <div className="container_login">
      <blockquote className="login_card">
        <h3 className="greeting">Welcome to Mail!</h3>
        <div className="info_message">{infoMessage}</div>
        <input
          className="login_ui"
          placeholder="Email address"
          type="email"
          value={emailInput}
          onKeyDown={onKeyDownInput}
          onChange={onChangeEmail}
          disabled={!!email}
        />
        {email ? (
          <>
            <input
              className="login_ui"
              placeholder="username"
              type="username"
              value={usernameInput}
              onKeyDown={onKeyDownInput}
              onChange={onChangeUsername}
              disabled={!!username}
            />
            <input
              className="login_ui"
              placeholder="password"
              type="password"
              value={passwordInput}
              onKeyDown={onKeyDownInput}
              onChange={onChangePassword}
            />
            {passwordInput ? (
              <input
                className="login_ui"
                placeholder="password to confirm"
                type="password"
                value={passwordConfirmInput}
                onKeyDown={onKeyDownInput}
                onChange={onChangePasswordConfirm}
              />
            ) : null}
          </>
        ) : null}
        <button className="login_ui" onClick={onClickSignUp}>
          {email ? (
            <>
              <UserEditIcon />
              <span>Set Up</span>
            </>
          ) : (
            <>
              <SignUpIcon />
              <span>Send Confirm Email</span>
            </>
          )}
        </button>
        <div className="card_footer">
          <div className="info_message">
            <span>Already have an account?</span>
            &nbsp;
            <Link to="/sign-in">Sign In</Link>
          </div>
        </div>
      </blockquote>
    </div>
  );
};

export default SignUp;
